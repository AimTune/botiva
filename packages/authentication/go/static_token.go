// Package authentication ships concrete Authenticator adapters for the
// github.com/aimtune/botiva/core auth port (PROTOCOL.md §2.1) — the Go
// counterpart of the @botiva/authentication package. The port itself lives in
// core; this module is a separate module (like the langchaingo adapter) so
// core stays free of it, but it depends only on the standard library.
package authentication

import (
	"context"

	botiva "github.com/aimtune/botiva/core"
)

// StaticTokenAuthenticator verifies a shared secret / API key against a static
// token → userId map — the simplest real authenticator.
//
//	authentication.NewStaticTokenAuthenticator(map[string]string{"sk-alice": "user-alice"})
type StaticTokenAuthenticator struct {
	tokens map[string]string
}

// NewStaticTokenAuthenticator copies the token → userId map.
func NewStaticTokenAuthenticator(tokens map[string]string) *StaticTokenAuthenticator {
	copied := make(map[string]string, len(tokens))
	for k, v := range tokens {
		copied[k] = v
	}
	return &StaticTokenAuthenticator{tokens: copied}
}

// Authenticate maps a known token to its userId.
func (a *StaticTokenAuthenticator) Authenticate(_ context.Context, ac botiva.AuthContext) (botiva.AuthResult, error) {
	if ac.Token == "" {
		return botiva.AuthResult{OK: false, Reason: "missing token"}, nil
	}
	userID, ok := a.tokens[ac.Token]
	if !ok {
		return botiva.AuthResult{OK: false, Reason: "invalid token"}, nil
	}
	return botiva.AuthResult{OK: true, UserID: userID}, nil
}
