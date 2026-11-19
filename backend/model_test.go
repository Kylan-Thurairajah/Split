package main

import (
	"reflect"
	"testing"
	"time"
)

func TestAllocationRounding(t *testing.T) {
	item := Item{UnitCents: 1000, Quantity: 1, Mode: "equal", Members: []string{"sam", "alex", "jordan"}}
	if err := calculateAllocations(&item, participants); err != nil {
		t.Fatal(err)
	}
	want := map[string]int64{"alex": 334, "jordan": 333, "sam": 333}
	if !reflect.DeepEqual(item.Allocations, want) {
		t.Fatalf("allocations = %v, want %v", item.Allocations, want)
	}
	if !reflect.DeepEqual(item.Members, []string{"alex", "jordan", "sam"}) {
		t.Fatalf("member order = %v", item.Members)
	}
}

func TestInvalidAllocations(t *testing.T) {
	cases := []Item{
		{UnitCents: 1000, Quantity: 1, Mode: "equal", Members: []string{"alex", "alex"}},
		{UnitCents: 1000, Quantity: 1, Mode: "equal", Members: []string{"other"}},
		{UnitCents: 1000, Quantity: 1, Mode: "owner", Members: []string{"alex", "jordan"}},
		{UnitCents: 1000, Quantity: 1, Mode: "custom", Shares: map[string]int64{"alex": 999}},
		{UnitCents: 1000, Quantity: 1, Mode: "custom", Shares: map[string]int64{"alex": 1000, "other": 0}},
		{UnitCents: 1000, Quantity: 1, Mode: "custom", Shares: map[string]int64{"alex": -1, "sam": 1001}},
		{UnitCents: 1000, Quantity: maxQuantity + 1, Mode: "owner", Members: []string{"alex"}},
	}
	for _, item := range cases {
		if err := calculateAllocations(&item, participants); err == nil {
			t.Errorf("accepted invalid item: %+v", item)
		}
	}
}

func TestCartTotalsAndReset(t *testing.T) {
	now := time.Now()
	cart := newCart("demo", true, "")
	expectedTotal := int64(28794)
	if cart.TotalCents != expectedTotal {
		t.Fatalf("demo total = %d, want %d", cart.TotalCents, expectedTotal)
	}
	item := Item{Name: "New lamp", UnitCents: 301, Quantity: 3, Mode: "custom", Shares: map[string]int64{"alex": 402, "jordan": 300, "sam": 201}}
	if err := cart.apply(Mutation{Action: "upsert", Actor: "alex", Item: &item}, now); err != nil {
		t.Fatal(err)
	}
	if cart.TotalCents != expectedTotal+903 || cart.Totals["alex"]+cart.Totals["jordan"]+cart.Totals["sam"] != cart.TotalCents {
		t.Fatalf("cart totals do not reconcile: %+v", cart.Totals)
	}
	if err := cart.apply(Mutation{Action: "checkout", Actor: "alex"}, now); err != nil {
		t.Fatal(err)
	}
	if err := cart.apply(Mutation{Action: "remove", Actor: "alex", ItemID: "lamp"}, now); err == nil {
		t.Fatal("removed an item after checkout")
	}
	if err := cart.apply(Mutation{Action: "reset", Actor: "jordan"}, now); err != nil {
		t.Fatal(err)
	}
	if cart.Version != 4 || cart.CompletedAt != nil || len(cart.Items) != 5 || cart.TotalCents != expectedTotal {
		t.Fatalf("unexpected reset state: %+v", cart)
	}
}
