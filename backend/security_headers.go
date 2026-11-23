package main

import (
	"net/http"
	"net/url"
	"strings"
)

func browserSecurity(next http.Handler, authIssuer string) http.Handler {
	connectSources := "'self'"
	if issuer, err := url.Parse(authIssuer); err == nil && issuer.Scheme == "https" &&
		issuer.Hostname() != "" && issuer.User == nil && !strings.ContainsAny(issuer.Host, " ;,") {
		connectSources += " " + issuer.Scheme + "://" + issuer.Host
	}
	policy := "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src " +
		connectSources + "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", policy)
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}
