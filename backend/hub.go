package main

import (
	"sync"
)

type Hub struct {
	mu    sync.Mutex
	rooms map[string]map[chan Cart]struct{}
}

func (hub *Hub) subscribe(id string) (chan Cart, func()) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.rooms[id] == nil {
		hub.rooms[id] = make(map[chan Cart]struct{})
	}
	updates := make(chan Cart, 1)
	hub.rooms[id][updates] = struct{}{}
	return updates, func() {
		hub.mu.Lock()
		defer hub.mu.Unlock()
		delete(hub.rooms[id], updates)
		if len(hub.rooms[id]) == 0 {
			delete(hub.rooms, id)
		}
	}
}

func (hub *Hub) publish(cart Cart) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	for updates := range hub.rooms[cart.ID] {
		// A full newer snapshot supersedes any pending update. HTTP handlers
		// can publish out of commit order.
		select {
		case pending := <-updates:
			if pending.Version > cart.Version {
				updates <- pending
				continue
			}
		default:
		}
		updates <- cart
	}
}
