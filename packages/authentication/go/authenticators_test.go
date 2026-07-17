package authentication

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"

	botiva "github.com/aimtune/botiva/core"
)

func makeJWT(t *testing.T, secret, sub string, extra map[string]any) string {
	t.Helper()
	enc := func(v any) string {
		raw, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	head := enc(map[string]any{"alg": "HS256", "typ": "JWT"})
	claims := map[string]any{"sub": sub}
	for k, v := range extra {
		claims[k] = v
	}
	body := enc(claims)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(head + "." + body))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return head + "." + body + "." + sig
}

func TestStaticTokenAuthenticator(t *testing.T) {
	a := NewStaticTokenAuthenticator(map[string]string{"sk-alice": "user-alice"})
	if res, _ := a.Authenticate(context.Background(), botiva.AuthContext{Token: "sk-alice"}); !res.OK || res.UserID != "user-alice" {
		t.Fatalf("valid token: got %+v", res)
	}
	if res, _ := a.Authenticate(context.Background(), botiva.AuthContext{Token: "nope"}); res.OK {
		t.Fatal("invalid token should be rejected")
	}
	if res, _ := a.Authenticate(context.Background(), botiva.AuthContext{}); res.OK {
		t.Fatal("missing token should be rejected")
	}
}

func TestHmacJwtAuthenticator(t *testing.T) {
	const secret = "test-secret"
	a := NewHmacJwtAuthenticator(HmacJwtOptions{Secret: secret})

	good := makeJWT(t, secret, "user-jwt", map[string]any{"role": "admin"})
	res, err := a.Authenticate(context.Background(), botiva.AuthContext{Token: good})
	if err != nil || !res.OK || res.UserID != "user-jwt" || res.Claims["role"] != "admin" {
		t.Fatalf("valid jwt: got %+v err=%v", res, err)
	}

	forged := makeJWT(t, "wrong-secret", "user-jwt", nil)
	if res, _ := a.Authenticate(context.Background(), botiva.AuthContext{Token: forged}); res.OK {
		t.Fatal("forged signature should be rejected")
	}
	expired := makeJWT(t, secret, "user-jwt", map[string]any{"exp": 1})
	if res, _ := a.Authenticate(context.Background(), botiva.AuthContext{Token: expired}); res.OK {
		t.Fatal("expired token should be rejected")
	}
	if res, _ := a.Authenticate(context.Background(), botiva.AuthContext{Token: "not-a-jwt"}); res.OK {
		t.Fatal("malformed token should be rejected")
	}
}

func TestCookieAuthenticator(t *testing.T) {
	const secret = "test-secret"
	a := NewCookieAuthenticator("botiva_session", NewHmacJwtAuthenticator(HmacJwtOptions{Secret: secret}))
	token := makeJWT(t, secret, "user-cookie", nil)

	res, _ := a.Authenticate(context.Background(), botiva.AuthContext{
		Headers: map[string]string{"cookie": "other=1; botiva_session=" + token},
	})
	if !res.OK || res.UserID != "user-cookie" {
		t.Fatalf("cookie credential: got %+v", res)
	}
	if res, _ := a.Authenticate(context.Background(), botiva.AuthContext{Headers: map[string]string{"cookie": "unrelated=x"}}); res.OK {
		t.Fatal("absent cookie should be rejected")
	}
}
