module github.com/aimtune/botiva/examples/server

go 1.22

require (
	github.com/aimtune/botiva/core v0.0.0
	github.com/aimtune/botiva/server/ws v0.0.0
)

replace github.com/aimtune/botiva/core => ../../../packages/core/go

replace github.com/aimtune/botiva/server/ws => ../../../packages/server/go
