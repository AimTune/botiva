package botiva

import (
	"context"
	"encoding/json"
	"sync"
)

// StateStore is the persistence port (PROTOCOL.md §8).
type StateStore interface {
	Get(ctx context.Context, key string) (json.RawMessage, error) // nil when missing
	Set(ctx context.Context, key string, value json.RawMessage) error
	Delete(ctx context.Context, key string) error
}

// MemoryStateStore is the in-process StateStore.
type MemoryStateStore struct {
	mu sync.RWMutex
	m  map[string]json.RawMessage
}

func NewMemoryStateStore() *MemoryStateStore {
	return &MemoryStateStore{m: map[string]json.RawMessage{}}
}

func (s *MemoryStateStore) Get(_ context.Context, key string) (json.RawMessage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.m[key], nil
}

func (s *MemoryStateStore) Set(_ context.Context, key string, value json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[key] = value
	return nil
}

func (s *MemoryStateStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, key)
	return nil
}

// ScopedStore is a namespaced JSON-object view over one StateStore key.
type ScopedStore struct {
	store StateStore
	Key   string
}

func (s *ScopedStore) Get(ctx context.Context) (map[string]any, error) {
	raw, err := s.store.Get(ctx, s.Key)
	if err != nil || raw == nil {
		return nil, err
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func (s *ScopedStore) Set(ctx context.Context, value map[string]any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.store.Set(ctx, s.Key, raw)
}

// Patch shallow-merges into the current value and returns the result.
func (s *ScopedStore) Patch(ctx context.Context, partial map[string]any) (map[string]any, error) {
	current, err := s.Get(ctx)
	if err != nil {
		return nil, err
	}
	if current == nil {
		current = map[string]any{}
	}
	for k, v := range partial {
		if v == nil {
			delete(current, k)
			continue
		}
		current[k] = v
	}
	return current, s.Set(ctx, current)
}

func (s *ScopedStore) DeleteAll(ctx context.Context) error {
	return s.store.Delete(ctx, s.Key)
}

// UserStore — per-user state (key "user:{userId}"), survives conversations/devices.
type UserStore struct {
	ScopedStore
	UserID string
}

func NewUserStore(store StateStore, userID string) *UserStore {
	return &UserStore{ScopedStore{store, "user:" + userID}, userID}
}

// ConversationStore — per-conversation state (key "conv:{conversationId}").
type ConversationStore struct {
	ScopedStore
	ConversationID string
}

func NewConversationStore(store StateStore, conversationID string) *ConversationStore {
	return &ConversationStore{ScopedStore{store, "conv:" + conversationID}, conversationID}
}

// HistoryStore is the transcript port (PROTOCOL.md §8).
type HistoryStore interface {
	Append(ctx context.Context, conversationID string, frame Frame) (int, error)
	After(ctx context.Context, conversationID string, watermark int) ([]Frame, error)
	Latest(ctx context.Context, conversationID string) (int, error)
}

// MemoryHistoryStore is the in-process HistoryStore.
type MemoryHistoryStore struct {
	mu        sync.Mutex
	maxFrames int
	convs     map[string]*histEntry
}

type histEntry struct {
	baseSeq int
	frames  []Frame
}

func NewMemoryHistoryStore(maxFrames int) *MemoryHistoryStore {
	if maxFrames <= 0 {
		maxFrames = 1000
	}
	return &MemoryHistoryStore{maxFrames: maxFrames, convs: map[string]*histEntry{}}
}

func (h *MemoryHistoryStore) Append(_ context.Context, conversationID string, frame Frame) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	entry := h.convs[conversationID]
	if entry == nil {
		entry = &histEntry{}
		h.convs[conversationID] = entry
	}
	seq := entry.baseSeq + len(entry.frames) + 1
	stored := Frame{}
	for k, v := range frame {
		stored[k] = v
	}
	stored["seq"] = seq
	entry.frames = append(entry.frames, stored)
	for len(entry.frames) > h.maxFrames {
		entry.frames = entry.frames[1:]
		entry.baseSeq++
	}
	return seq, nil
}

func (h *MemoryHistoryStore) After(_ context.Context, conversationID string, watermark int) ([]Frame, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	entry := h.convs[conversationID]
	if entry == nil {
		return nil, nil
	}
	var out []Frame
	for _, f := range entry.frames {
		if seq, ok := f["seq"].(int); ok && seq > watermark {
			out = append(out, f)
		}
	}
	return out, nil
}

func (h *MemoryHistoryStore) Latest(_ context.Context, conversationID string) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	entry := h.convs[conversationID]
	if entry == nil {
		return 0, nil
	}
	return entry.baseSeq + len(entry.frames), nil
}
