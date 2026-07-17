package authentication

import (
	"context"
	"net/url"
	"strings"

	botiva "github.com/aimtune/botiva/core"
)

// CookieAuthenticator extracts a credential from a named cookie in the request
// headers, then delegates verification to an inner authenticator. Browsers
// attach cookies automatically, so this needs no client-side token plumbing —
// pair it with an HMAC-JWT or static-token verifier.
//
//	authentication.NewCookieAuthenticator("botiva_session", jwtAuth)
type CookieAuthenticator struct {
	cookie string
	inner  botiva.Authenticator
}

// NewCookieAuthenticator panics on an empty cookie name or nil inner.
func NewCookieAuthenticator(cookie string, inner botiva.Authenticator) *CookieAuthenticator {
	if cookie == "" {
		panic("authentication: CookieAuthenticator requires a cookie name")
	}
	if inner == nil {
		panic("authentication: CookieAuthenticator requires an inner authenticator")
	}
	return &CookieAuthenticator{cookie: cookie, inner: inner}
}

// Authenticate reads the cookie (falling back to any existing ac.Token) and
// forwards to the inner authenticator.
func (a *CookieAuthenticator) Authenticate(ctx context.Context, ac botiva.AuthContext) (botiva.AuthResult, error) {
	if token, ok := ParseCookies(ac.Headers["cookie"])[a.cookie]; ok {
		ac.Token = token
	}
	return a.inner.Authenticate(ctx, ac)
}

// ParseCookies parses a Cookie header value into a name → value map.
func ParseCookies(header string) map[string]string {
	out := map[string]string{}
	if header == "" {
		return out
	}
	for _, pair := range strings.Split(header, ";") {
		eq := strings.IndexByte(pair, '=')
		if eq < 0 {
			continue
		}
		name := strings.TrimSpace(pair[:eq])
		if name == "" {
			continue
		}
		value := strings.TrimSpace(pair[eq+1:])
		if decoded, err := url.QueryUnescape(value); err == nil {
			value = decoded
		}
		out[name] = value
	}
	return out
}
