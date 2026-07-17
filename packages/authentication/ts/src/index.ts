// @botiva/authentication — concrete Authenticator adapters for the
// @botiva/core auth port (PROTOCOL.md §2.1).
//
// The port itself (`Authenticator`, `AuthContext`, `AuthResult`,
// `AuthenticationError`, `AllowAllAuthenticator`) lives in @botiva/core, the
// way `StateStore` lives in core and `@botiva/redis` ships an implementation.
// This package ships the reusable verifiers and re-exports the port types so a
// consumer only needs one import.
//
//   import { HmacJwtAuthenticator, CookieAuthenticator } from "@botiva/authentication";
//
//   const engine = new ConversationEngine({
//       runtime,
//       authenticator: new CookieAuthenticator({
//           cookie: "botiva_session",
//           inner: new HmacJwtAuthenticator({ secret: process.env.JWT_SECRET! }),
//       }),
//   });

export {
    AllowAllAuthenticator,
    AuthenticationError,
    AUTH_CLOSE_CODE,
} from "@botiva/core";
export type { AuthContext, AuthResult, Authenticator } from "@botiva/core";

export { StaticTokenAuthenticator } from "./static-token.js";
export { HmacJwtAuthenticator, type HmacJwtOptions } from "./hmac-jwt.js";
export { CookieAuthenticator, parseCookies, type CookieAuthenticatorOptions } from "./cookie.js";
