package botiva

import "context"

// Authentication port — the Go counterpart of @botiva/core's auth port
// (PROTOCOL.md §2.1). An Authenticator gates Connect(): it can reject a
// connection attempt or replace the client-asserted UserID with a verified one.
//
// Without an authenticator the engine behaves as before — identity is
// client-asserted and every connection is accepted. With one, Connect() returns
// an *AuthenticationError on rejection; transports translate that into a wire
// `error` frame + a close (WebSocket close code AuthCloseCode).

// AuthContext is everything a transport knows about a connection attempt.
type AuthContext struct {
	Transport      string            // "websocket" | "socket.io" | ...
	Token          string            // credential, if any
	Query          map[string]string // request query parameters
	Headers        map[string]string // request headers (lower-cased keys)
	UserID         string            // client-asserted (unverified)
	ConversationID string
}

// AuthResult is the verdict returned by an Authenticator.
type AuthResult struct {
	OK     bool
	UserID string         // verified identity; overrides the client-asserted one when set
	Claims map[string]any // verified claims, exposed via TurnContext.Meta["auth"]
	Reason string         // rejection reason (only meaningful when OK is false)
}

// Authenticator is the authentication port: decide whether a connection may
// proceed. Mirrors the TS `Authenticator` interface.
type Authenticator interface {
	Authenticate(ctx context.Context, ac AuthContext) (AuthResult, error)
}

// AllowAllAuthenticator preserves the no-auth behaviour (open door).
type AllowAllAuthenticator struct{}

// Authenticate accepts every attempt, keeping the client-asserted identity.
func (AllowAllAuthenticator) Authenticate(_ context.Context, ac AuthContext) (AuthResult, error) {
	return AuthResult{OK: true, UserID: ac.UserID}, nil
}

// AuthenticationError is returned by Connect() when an authenticator rejects the
// attempt. Transports catch it (errors.As) and emit an `error` frame + close.
type AuthenticationError struct {
	Code   string
	Reason string
}

func (e *AuthenticationError) Error() string { return e.Reason }

// AuthCloseCode is the WebSocket close code for an auth rejection
// (application range 4000–4999).
const AuthCloseCode = 4401

// AuthInput carries the credential + request material a transport hands the
// Authenticator via ConnectParams.
type AuthInput struct {
	Transport string
	Token     string
	Query     map[string]string
	Headers   map[string]string
}

// ErrorFrame builds a transient `error` frame (auth rejection, protocol error).
func ErrorFrame(code, message string) Frame {
	return Frame{"type": "error", "data": map[string]any{"code": code, "message": message}}
}
