package main

import (
	"sync"
)

type Hub struct {
	mu      sync.Mutex
	rooms   map[string]map[chan Cart]struct{}
	viewers map[chan Cart]socketViewer
}

type socketViewer struct {
	profile string
	revoked chan struct{}
}

func (hub *Hub) subscribe(id, profile string) (chan Cart, <-chan struct{}, func()) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.rooms[id] == nil {
		hub.rooms[id] = make(map[chan Cart]struct{})
	}
	updates := make(chan Cart, 1)
	revoked := make(chan struct{})
	hub.rooms[id][updates] = struct{}{}
	if profile != "" {
		if hub.viewers == nil {
			hub.viewers = make(map[chan Cart]socketViewer)
		}
		hub.viewers[updates] = socketViewer{profile: profile, revoked: revoked}
	}
	return updates, revoked, func() {
		hub.mu.Lock()
		defer hub.mu.Unlock()
		delete(hub.rooms[id], updates)
		delete(hub.viewers, updates)
		if len(hub.rooms[id]) == 0 {
			delete(hub.rooms, id)
		}
	}
}

func (hub *Hub) evict(id, profile string) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	for updates := range hub.rooms[id] {
		viewer := hub.viewers[updates]
		if viewer.profile == profile {
			close(viewer.revoked)
			delete(hub.rooms[id], updates)
			delete(hub.viewers, updates)
		}
	}
	if len(hub.rooms[id]) == 0 {
		delete(hub.rooms, id)
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
