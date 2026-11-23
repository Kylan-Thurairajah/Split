package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

type Participant struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Color    string `json:"color"`
	Inactive bool   `json:"inactive,omitempty"`
}

type Item struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	UnitCents   int64            `json:"unitCents"`
	Quantity    int64            `json:"quantity"`
	Category    string           `json:"category"`
	Mode        string           `json:"mode"`
	Members     []string         `json:"members"`
	Shares      map[string]int64 `json:"shares"`
	Allocations map[string]int64 `json:"allocations"`
}

type Activity struct {
	Actor     string    `json:"actor"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"createdAt"`
	Name      string    `json:"name,omitempty"`
}

type Cart struct {
	ID           string           `json:"id"`
	Name         string           `json:"name"`
	Demo         bool             `json:"demo"`
	Private      bool             `json:"private,omitempty"`
	Version      int64            `json:"version"`
	Participants []Participant    `json:"participants"`
	Items        []Item           `json:"items"`
	TotalCents   int64            `json:"totalCents"`
	Totals       map[string]int64 `json:"totals"`
	CompletedAt  *time.Time       `json:"completedAt,omitempty"`
	Activity     *Activity        `json:"activity,omitempty"`
	Activities   []Activity       `json:"activities,omitempty"`
	Access       string           `json:"access,omitempty"`
	ActorID      string           `json:"actorId,omitempty"`
}

type Mutation struct {
	Version int64  `json:"version"`
	Action  string `json:"action"`
	Item    *Item  `json:"item"`
	ItemID  string `json:"itemId"`
	Actor   string `json:"actor"`
}

var participants = []Participant{
	{ID: "alex", Name: "Alex", Color: "#A68BDC"},
	{ID: "jordan", Name: "Jordan", Color: "#75B9AD"},
	{ID: "sam", Name: "Sam", Color: "#F4AE75"},
}

const (
	maxItems     = 100
	maxUnitCents = 100_000_000
	maxQuantity  = 999
)

func randomID() string {
	var bytes [16]byte
	rand.Read(bytes[:])
	return hex.EncodeToString(bytes[:])
}

func newCart(id string, demo bool, name string) Cart {
	cart := Cart{
		ID: id, Name: name, Demo: demo, Version: 1,
		Participants: participants, Items: []Item{},
	}
	if demo {
		cart.Name = "Apartment Essentials"
		cart.Items = []Item{
			{ID: "lamp", Name: "Studio desk lamp", UnitCents: 4999, Quantity: 1, Category: "lamp", Mode: "owner", Members: []string{"alex"}},
			{ID: "coffee", Name: "Pour-over coffee maker", UnitCents: 6495, Quantity: 1, Category: "coffee", Mode: "equal", Members: []string{"alex", "jordan", "sam"}},
			{ID: "storage", Name: "Woven storage basket", UnitCents: 2400, Quantity: 2, Category: "storage", Mode: "owner", Members: []string{"jordan"}},
			{ID: "rug", Name: "Everyday floor rug", UnitCents: 8900, Quantity: 1, Category: "rug", Mode: "custom", Shares: map[string]int64{"alex": 3000, "jordan": 3000, "sam": 2900}},
			{ID: "kitchen", Name: "Ceramic dinnerware set", UnitCents: 3600, Quantity: 1, Category: "kitchen", Mode: "owner", Members: []string{"sam"}},
		}
	}
	if err := cart.recalculate(); err != nil {
		panic(err)
	}
	return cart
}

func (cart *Cart) recalculate() error {
	cart.Totals = make(map[string]int64, len(cart.Participants))
	cart.TotalCents = 0
	for _, p := range cart.Participants {
		cart.Totals[p.ID] = 0
	}
	for index := range cart.Items {
		item := &cart.Items[index]
		if err := calculateAllocations(item, cart.Participants); err != nil {
			return err
		}
		cart.TotalCents += item.UnitCents * item.Quantity
		for id, amount := range item.Allocations {
			cart.Totals[id] += amount
		}
	}
	return nil
}

func calculateAllocations(item *Item, people []Participant) error {
	if item.UnitCents < 1 || item.UnitCents > maxUnitCents || item.Quantity < 1 || item.Quantity > maxQuantity {
		return errors.New("Enter a positive price up to $1,000,000 and a quantity from 1 to 999.")
	}
	total := item.UnitCents * item.Quantity
	item.Allocations = make(map[string]int64)
	known := make(map[string]bool, len(people))
	for _, p := range people {
		known[p.ID] = true
	}
	switch item.Mode {
	case "owner", "equal":
		if len(item.Members) == 0 || (item.Mode == "owner" && len(item.Members) != 1) {
			return errors.New("Select the participants sharing this item.")
		}
		selected := make(map[string]bool, len(item.Members))
		for _, id := range item.Members {
			if !known[id] || selected[id] {
				return errors.New("Select distinct cart participants.")
			}
			selected[id] = true
		}
		item.Shares = nil
		item.Members = make([]string, 0, len(selected))
		// The cart's participant order deterministically assigns leftover cents.
		count := int64(len(selected))
		remaining := total % count
		for _, p := range people {
			if selected[p.ID] {
				item.Members = append(item.Members, p.ID)
				item.Allocations[p.ID] = total / count
				if remaining > 0 {
					item.Allocations[p.ID]++
					remaining--
				}
			}
		}
	case "custom":
		item.Members = nil
		sum := int64(0)
		for id, amount := range item.Shares {
			if !known[id] || amount < 0 || amount > total {
				return errors.New("Enter valid amounts for cart participants.")
			}
			sum += amount
			item.Allocations[id] = amount
		}
		if sum != total {
			return errors.New("Custom amounts must add up to the item total.")
		}
	default:
		return errors.New("Choose an allocation method.")
	}
	return nil
}

func (cart *Cart) apply(m Mutation, now time.Time) error {
	actorValid := false
	for _, p := range cart.Participants {
		actorValid = actorValid || p.ID == m.Actor
	}
	if !actorValid {
		return errors.New("Choose a cart participant.")
	}
	if cart.CompletedAt != nil && m.Action != "reset" {
		return errors.New("This cart has already completed checkout.")
	}
	activity := ""
	switch m.Action {
	case "upsert":
		if m.Item == nil {
			return errors.New("Enter item details.")
		}
		item := *m.Item
		item.Name = strings.TrimSpace(item.Name)
		item.Category = strings.TrimSpace(item.Category)
		if item.Name == "" || len([]rune(item.Name)) > 100 || len(item.Category) > 32 {
			return errors.New("Enter an item name up to 100 characters and a category up to 32 characters.")
		}
		if item.Category == "" {
			item.Category = "other"
		}
		index := cart.itemIndex(item.ID)
		if err := calculateAllocations(&item, cart.Participants); err != nil {
			return err
		}
		for _, person := range cart.Participants {
			if !person.Inactive || item.Allocations[person.ID] == 0 {
				continue
			}
			if index == -1 || cart.Items[index].Allocations[person.ID] == 0 {
				return errors.New("A removed member cannot be assigned new items.")
			}
		}
		if item.ID == "" {
			if len(cart.Items) >= maxItems {
				return fmt.Errorf("This cart can hold up to %d items.", maxItems)
			}
			item.ID = randomID()
			cart.Items = append(cart.Items, item)
			activity = "added " + item.Name
		} else {
			if index == -1 {
				return errors.New("This item no longer exists.")
			}
			cart.Items[index] = item
			activity = "updated " + item.Name
		}
	case "remove":
		index := cart.itemIndex(m.ItemID)
		if index == -1 {
			return errors.New("This item no longer exists.")
		}
		activity = "removed " + cart.Items[index].Name
		cart.Items = append(cart.Items[:index], cart.Items[index+1:]...)
	case "checkout":
		if len(cart.Items) == 0 {
			return errors.New("Add an item before checkout.")
		}
		cart.CompletedAt = &now
		activity = "completed checkout"
		if cart.Demo {
			activity = "completed demo checkout"
		}
	case "reset":
		if !cart.Demo {
			return errors.New("Demo reset is only available on seeded carts.")
		}
		version := cart.Version
		*cart = newCart(cart.ID, true, "")
		cart.Version = version
		activity = "reset the demo"
	default:
		return errors.New("Unknown cart action.")
	}
	if err := cart.recalculate(); err != nil {
		return err
	}
	cart.record(m.Actor, activity, now)
	return nil
}

func (cart Cart) hasAllocation(id string) bool {
	for _, item := range cart.Items {
		if _, found := item.Allocations[id]; found {
			return true
		}
	}
	return false
}

func (cart *Cart) record(actor, text string, now time.Time) {
	cart.Version++
	cart.Activity = &Activity{Actor: actor, Text: text, CreatedAt: now}
	if cart.Private {
		for _, person := range cart.Participants {
			if person.ID == actor {
				cart.Activity.Name = person.Name
				break
			}
		}
		cart.Activities = append([]Activity{*cart.Activity}, cart.Activities...)
		if len(cart.Activities) > 100 {
			cart.Activities = cart.Activities[:100]
		}
	}
}

func (cart Cart) itemIndex(id string) int {
	for i, item := range cart.Items {
		if item.ID == id {
			return i
		}
	}
	return -1
}
