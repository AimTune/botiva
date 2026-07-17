package authentication

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	botiva "github.com/aimtune/botiva/core"
)

// HmacJwtAuthenticator verifies an HS256 JSON Web Token with the standard
// library only: it checks the signature, `exp` and `nbf`, then maps the subject
// claim to the verified userId and exposes the full payload as claims.
//
//	authentication.NewHmacJwtAuthenticator(authentication.HmacJwtOptions{Secret: secret})
type HmacJwtAuthenticator struct {
	secret  []byte
	subject string
	skewSec int64
}

// HmacJwtOptions configure the JWT authenticator.
type HmacJwtOptions struct {
	Secret            string // shared HS256 secret
	SubjectClaim      string // claim carrying the userId; default "sub"
	ClockToleranceSec int64  // skew tolerance for exp/nbf; default 0
}

// NewHmacJwtAuthenticator panics if Secret is empty.
func NewHmacJwtAuthenticator(opts HmacJwtOptions) *HmacJwtAuthenticator {
	if opts.Secret == "" {
		panic("authentication: HmacJwtAuthenticator requires a secret")
	}
	subject := opts.SubjectClaim
	if subject == "" {
		subject = "sub"
	}
	return &HmacJwtAuthenticator{secret: []byte(opts.Secret), subject: subject, skewSec: opts.ClockToleranceSec}
}

// Authenticate verifies the token in ac.Token.
func (a *HmacJwtAuthenticator) Authenticate(_ context.Context, ac botiva.AuthContext) (botiva.AuthResult, error) {
	if ac.Token == "" {
		return botiva.AuthResult{OK: false, Reason: "missing token"}, nil
	}
	payload := a.verify(ac.Token)
	if payload == nil {
		return botiva.AuthResult{OK: false, Reason: "invalid or expired token"}, nil
	}
	userID, ok := payload[a.subject].(string)
	if !ok || userID == "" {
		return botiva.AuthResult{OK: false, Reason: "token missing \"" + a.subject + "\" claim"}, nil
	}
	return botiva.AuthResult{OK: true, UserID: userID, Claims: payload}, nil
}

func (a *HmacJwtAuthenticator) verify(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	signingInput := parts[0] + "." + parts[1]
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil
	}
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte(signingInput))
	if subtle.ConstantTimeCompare(sig, mac.Sum(nil)) != 1 {
		return nil
	}

	headerRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil
	}
	var header map[string]any
	if json.Unmarshal(headerRaw, &header) != nil || header["alg"] != "HS256" {
		return nil
	}
	payloadRaw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var payload map[string]any
	if json.Unmarshal(payloadRaw, &payload) != nil {
		return nil
	}
	now := time.Now().Unix()
	if exp, ok := payload["exp"].(float64); ok && now > int64(exp)+a.skewSec {
		return nil
	}
	if nbf, ok := payload["nbf"].(float64); ok && now+a.skewSec < int64(nbf) {
		return nil
	}
	return payload
}
