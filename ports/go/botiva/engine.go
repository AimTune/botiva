package botiva

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"sync"
	"time"
)

// Runtime is the driving port (PROTOCOL.md §8): the only thing an agent
// framework adapter implements.
type Runtime interface {
	Run(ctx context.Context, input RunInput, tc *TurnContext) (<-chan AgentEvent, error)
}

// PendingInterrupt is a paused HITL question waiting for the user's answer.
type PendingInterrupt struct {
	ID      string `json:"id,omitempty"`
	Payload any    `json:"payload,omitempty"`
	At      int64  `json:"at"`
}

// RunInput: exactly one of Text / Resume is meaningful per turn.
type RunInput struct {
	Text      string
	Resume    string
	IsResume  bool
	Interrupt *PendingInterrupt
}

// TurnContext mirrors @botiva/core TurnContext.
type TurnContext struct {
	ConversationID    string
	UserID            string
	UserStore         *UserStore
	ConversationStore *ConversationStore
	Log               *slog.Logger
	Meta              map[string]any
	emit              func(AgentEvent)
}

// Emit pushes an out-of-band event into the current turn.
func (tc *TurnContext) Emit(ev AgentEvent) { tc.emit(ev) }

// Extension mirrors the @botiva/core Extension port. Function fields keep the
// shape identical to the TS optional methods; nil return = swallow/drop.
type Extension struct {
	Name                string
	OnMessage           func(ctx context.Context, msg IncomingMessage, tc *TurnContext) *IncomingMessage
	OnEvent             func(ctx context.Context, ev AgentEvent, tc *TurnContext) *AgentEvent
	OnConversationStart func(ctx context.Context, tc *TurnContext)
	OnConversationEnd   func(ctx context.Context, tc *TurnContext)
	OnConnect           func(ctx context.Context, connectionID string, tc *TurnContext)
	OnDisconnect        func(ctx context.Context, connectionID string, tc *TurnContext)
}

// ConnectParams mirror engine.connect() (PROTOCOL.md §8).
type ConnectParams struct {
	UserID         string
	ConversationID string
	Watermark      int
	// Deliver writes one frame to the client. It MUST be safe for concurrent
	// use: an ambient Emit inside a tool dispatches on the runtime goroutine
	// while the engine drains runtime events on another (the ws transport
	// serializes its writes via an internal mutex).
	Deliver func(Frame)
	Meta    map[string]any
}

// Connection is the handle a transport holds for one attached client.
type Connection struct {
	ID             string
	UserID         string
	ConversationID string
	engine         *ConversationEngine
	live           *liveConnection
	closed         bool
}

type liveConnection struct {
	id             string
	userID         string
	conversationID string
	meta           map[string]any
	deliver        func(Frame)
}

// EngineOptions configure NewConversationEngine.
type EngineOptions struct {
	Runtime      Runtime
	StateStore   StateStore
	HistoryStore HistoryStore
	Extensions   []Extension
	Logger       *slog.Logger
	Greeting     string
}

// ConversationEngine — Go port of the botiva engine. Same responsibilities:
// identity, watermark replay, per-conversation turn lock, HITL, fan-out.
type ConversationEngine struct {
	runtime    Runtime
	store      StateStore
	history    HistoryStore
	extensions []Extension
	log        *slog.Logger
	greeting   string

	mu        sync.Mutex
	live      map[string]map[*liveConnection]struct{}
	turnLocks map[string]bool
}

func NewConversationEngine(opts EngineOptions) *ConversationEngine {
	if opts.Runtime == nil {
		panic("botiva: ConversationEngine requires a Runtime")
	}
	store := opts.StateStore
	if store == nil {
		store = NewMemoryStateStore()
	}
	history := opts.HistoryStore
	if history == nil {
		history = NewMemoryHistoryStore(0)
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &ConversationEngine{
		runtime:    opts.Runtime,
		store:      store,
		history:    history,
		extensions: opts.Extensions,
		log:        logger,
		greeting:   opts.Greeting,
		live:       map[string]map[*liveConnection]struct{}{},
		turnLocks:  map[string]bool{},
	}
}

type conversationRecord struct {
	UserID           string            `json:"userId"`
	CreatedAt        int64             `json:"createdAt"`
	PendingInterrupt *PendingInterrupt `json:"pendingInterrupt,omitempty"`
}

// Connect attaches a client. Mirrors engine.connect() in @botiva/core.
func (e *ConversationEngine) Connect(ctx context.Context, params ConnectParams) (*Connection, error) {
	if params.Deliver == nil {
		panic("botiva: Connect requires a Deliver callback")
	}
	conversationID := params.ConversationID
	if conversationID == "" {
		conversationID = newID("conv")
	}
	record, fresh, err := e.loadRecord(ctx, conversationID, params.UserID)
	if err != nil {
		return nil, err
	}
	userID := params.UserID
	if userID == "" {
		userID = record.UserID
	}

	live := &liveConnection{
		id:             newID("connection"),
		userID:         userID,
		conversationID: conversationID,
		meta:           params.Meta,
		deliver:        params.Deliver,
	}
	e.mu.Lock()
	set := e.live[conversationID]
	if set == nil {
		set = map[*liveConnection]struct{}{}
		e.live[conversationID] = set
	}
	set[live] = struct{}{}
	e.mu.Unlock()

	tc := e.turnContext(conversationID, userID, live.meta, nil)
	if fresh {
		for _, ext := range e.extensions {
			if ext.OnConversationStart != nil {
				ext.OnConversationStart(ctx, tc)
			}
		}
	}
	for _, ext := range e.extensions {
		if ext.OnConnect != nil {
			ext.OnConnect(ctx, live.id, tc)
		}
	}

	// 1) welcome (transient)
	latest, err := e.history.Latest(ctx, conversationID)
	if err != nil {
		return nil, err
	}
	live.deliver(Frame{
		"type": "welcome",
		"data": map[string]any{
			"protocol":       ProtocolVersion,
			"conversationId": conversationID,
			"userId":         userID,
			"connectionId":   live.id,
			"watermark":      latest,
		},
	})
	// 2) replay
	if latest > params.Watermark {
		frames, err := e.history.After(ctx, conversationID, params.Watermark)
		if err != nil {
			return nil, err
		}
		for _, f := range frames {
			live.deliver(f)
		}
	}
	// 3) greeting on brand-new conversations
	if fresh && e.greeting != "" {
		e.Post(ctx, conversationID, Message(e.greeting))
	}

	return &Connection{
		ID: live.id, UserID: userID, ConversationID: conversationID,
		engine: e, live: live,
	}, nil
}

// Receive feeds one inbound wire payload (JSON string, bytes or frame map).
func (c *Connection) Receive(ctx context.Context, raw any) error {
	inbound := ParseIncoming(raw)
	if inbound == nil {
		return nil
	}
	if inbound.Hello != nil {
		c.engine.log.Warn("[botiva] late hello frame ignored (handshake happens on connect)")
		return nil
	}
	return c.engine.HandleMessage(ctx, c.ConversationID, *inbound.Message, &HandleOptions{
		UserID: c.UserID,
		origin: c.live,
	})
}

// Close detaches the connection; the conversation itself stays resumable.
func (c *Connection) Close(ctx context.Context) error {
	if c.closed {
		return nil
	}
	c.closed = true
	e := c.engine
	e.mu.Lock()
	set := e.live[c.ConversationID]
	delete(set, c.live)
	empty := len(set) == 0
	if empty {
		delete(e.live, c.ConversationID)
	}
	e.mu.Unlock()

	tc := e.turnContext(c.ConversationID, c.UserID, c.live.meta, nil)
	for _, ext := range e.extensions {
		if ext.OnDisconnect != nil {
			ext.OnDisconnect(ctx, c.live.id, tc)
		}
	}
	if empty {
		for _, ext := range e.extensions {
			if ext.OnConversationEnd != nil {
				ext.OnConversationEnd(ctx, tc)
			}
		}
	}
	return nil
}

// HandleOptions parametrize HandleMessage.
type HandleOptions struct {
	UserID string
	origin *liveConnection
}

// HandleMessage runs one turn. Mirrors engine.handleMessage() in @botiva/core.
func (e *ConversationEngine) HandleMessage(ctx context.Context, conversationID string, rawMessage IncomingMessage, opts *HandleOptions) error {
	if opts == nil {
		opts = &HandleOptions{}
	}
	record, _, err := e.loadRecord(ctx, conversationID, opts.UserID)
	if err != nil {
		return err
	}
	userID := opts.UserID
	if userID == "" {
		userID = record.UserID
	}

	// Turn events flow through this dispatcher (also used by TurnContext.Emit).
	var meta map[string]any
	if opts.origin != nil {
		meta = opts.origin.meta
	}
	tc := e.turnContext(conversationID, userID, meta, nil)

	// Turn state shared between the loop and out-of-band Emit calls.
	var turnMu sync.Mutex
	streamID := ""
	streamDone := false
	chunkSeq := 0

	dispatch := func(ev AgentEvent, only *liveConnection) {
		turnMu.Lock()
		if ev.Type == "interrupt" {
			pending := &PendingInterrupt{ID: ev.ID, Payload: ev.Payload, At: time.Now().UnixMilli()}
			record.PendingInterrupt = pending
			_ = e.saveRecord(ctx, conversationID, record)
		}
		if ev.Type == "genui" {
			if streamID == "" {
				if ev.StreamID != "" {
					streamID = ev.StreamID
				} else {
					streamID = newID("stream")
				}
			}
			if ev.StreamID == "" {
				ev.StreamID = streamID
			}
			chunkSeq++
			if ev.Chunk != nil && ev.Chunk.ID == nil {
				chunk := *ev.Chunk
				chunk.ID = chunkSeq
				ev.Chunk = &chunk
			}
			if ev.Done {
				streamDone = true
			}
		}
		turnMu.Unlock()
		e.dispatch(ctx, ev, tc, only)
	}
	tc.emit = func(ev AgentEvent) { dispatch(ev, nil) }

	msg := rawMessage
	for _, ext := range e.extensions {
		if ext.OnMessage == nil {
			continue
		}
		next := ext.OnMessage(ctx, msg, tc)
		if next == nil {
			return nil
		}
		msg = *next
	}
	if msg.Text == "" {
		return nil
	}

	e.mu.Lock()
	if e.turnLocks[conversationID] {
		e.mu.Unlock()
		dispatch(Busy(), opts.origin)
		return nil
	}
	e.turnLocks[conversationID] = true
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		delete(e.turnLocks, conversationID)
		e.mu.Unlock()
	}()

	// Persist + fan out the user's message (all connections except the sender).
	msgID := msg.ID
	if msgID == "" {
		msgID = newID("msg")
	}
	userFrame := Frame{
		"type": "text", "id": msgID, "from": "user",
		"data":      map[string]any{"text": msg.Text},
		"timestamp": time.Now().UnixMilli(),
	}
	seq, err := e.history.Append(ctx, conversationID, userFrame)
	if err != nil {
		return err
	}
	userFrame["seq"] = seq
	e.broadcast(conversationID, userFrame, opts.origin)

	// Pending interrupt? Then this message is the HITL answer.
	var input RunInput
	if record.PendingInterrupt != nil {
		input = RunInput{Resume: msg.Text, IsResume: true, Interrupt: record.PendingInterrupt}
		record.PendingInterrupt = nil
		if err := e.saveRecord(ctx, conversationID, record); err != nil {
			return err
		}
	} else {
		input = RunInput{Text: msg.Text}
	}

	events, err := e.runtime.Run(ctx, input, tc)
	if err != nil {
		dispatch(RunError(err.Error()), nil)
		return nil
	}
	for ev := range events {
		dispatch(ev, nil)
	}

	// Close a genui stream the runtime left open.
	turnMu.Lock()
	needClose := streamID != "" && !streamDone
	closingID := streamID
	turnMu.Unlock()
	if needClose {
		closing := GenUI(GenUIChunk{Type: "event", Name: "stream_done"})
		closing.StreamID = closingID
		closing.Done = true
		dispatch(closing, nil)
	}
	return nil
}

// Post delivers a proactive, out-of-turn event to a conversation.
func (e *ConversationEngine) Post(ctx context.Context, conversationID string, ev AgentEvent) {
	record, _, err := e.loadRecord(ctx, conversationID, "")
	userID := "system"
	if err == nil && record != nil {
		userID = record.UserID
	}
	tc := e.turnContext(conversationID, userID, nil, nil)
	tc.emit = func(inner AgentEvent) { e.Post(ctx, conversationID, inner) }
	e.dispatch(ctx, ev, tc, nil)
}

// ── internals ────────────────────────────────────────────────────────────────

func (e *ConversationEngine) dispatch(ctx context.Context, ev AgentEvent, tc *TurnContext, only *liveConnection) {
	out := &ev
	for _, ext := range e.extensions {
		if ext.OnEvent == nil {
			continue
		}
		out = ext.OnEvent(ctx, *out, tc)
		if out == nil {
			return
		}
	}
	for _, mapping := range EventToFrames(*out, newID) {
		frame := mapping.Frame
		if mapping.Persistent {
			seq, err := e.history.Append(ctx, tc.ConversationID, frame)
			if err != nil {
				e.log.Warn("[botiva] history append failed", "error", err)
				continue
			}
			stored := Frame{}
			for k, v := range frame {
				stored[k] = v
			}
			stored["seq"] = seq
			frame = stored
		}
		if only != nil {
			only.deliver(frame)
		} else {
			e.broadcast(tc.ConversationID, frame, nil)
		}
	}
}

func (e *ConversationEngine) broadcast(conversationID string, frame Frame, except *liveConnection) {
	e.mu.Lock()
	conns := make([]*liveConnection, 0, len(e.live[conversationID]))
	for conn := range e.live[conversationID] {
		if conn != except {
			conns = append(conns, conn)
		}
	}
	e.mu.Unlock()
	for _, conn := range conns {
		conn.deliver(frame)
	}
}

func (e *ConversationEngine) loadRecord(ctx context.Context, conversationID, preferredUserID string) (*conversationRecord, bool, error) {
	key := "conv:" + conversationID + ":botiva"
	raw, err := e.store.Get(ctx, key)
	if err != nil {
		return nil, false, err
	}
	if raw != nil {
		var record conversationRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return nil, false, err
		}
		return &record, false, nil
	}
	userID := preferredUserID
	if userID == "" {
		userID = newID("user")
	}
	record := &conversationRecord{UserID: userID, CreatedAt: time.Now().UnixMilli()}
	if err := e.saveRecord(ctx, conversationID, record); err != nil {
		return nil, false, err
	}
	return record, true, nil
}

func (e *ConversationEngine) saveRecord(ctx context.Context, conversationID string, record *conversationRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return e.store.Set(ctx, "conv:"+conversationID+":botiva", raw)
}

func (e *ConversationEngine) turnContext(conversationID, userID string, meta map[string]any, emit func(AgentEvent)) *TurnContext {
	if emit == nil {
		emit = func(AgentEvent) {}
	}
	if meta == nil {
		meta = map[string]any{}
	}
	return &TurnContext{
		ConversationID:    conversationID,
		UserID:            userID,
		UserStore:         NewUserStore(e.store, userID),
		ConversationStore: NewConversationStore(e.store, conversationID),
		Log:               e.log,
		Meta:              meta,
		emit:              emit,
	}
}

func newID(prefix string) string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return prefix + "-" + hex.EncodeToString(buf)
}
