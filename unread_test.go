package main

import "testing"

func TestUnreadCountPerRecipientPersists(t *testing.T) {
	dir := t.TempDir()
	s, err := LoadStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a, _, err := s.CreateUser("alice", "Alice", "password123")
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := s.CreateUser("bob", "Bob", "password123")
	if err != nil {
		t.Fatal(err)
	}
	conv, err := s.NewConvWith(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := s.AddMessage(conv.ID, b.ID, b.Nickname, "hello", ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AddMessage(conv.ID, a.ID, a.Nickname, "reply", ""); err != nil {
		t.Fatal(err)
	}
	check := func(store *Store, userID string, want int) {
		t.Helper()
		convs := store.ListConvs(userID)
		if len(convs) != 1 || convs[0].UnreadCount != want {
			t.Fatalf("user %s unread = %+v, want %d", userID, convs, want)
		}
	}
	check(s, a.ID, 3)
	check(s, b.ID, 1)
	if err := s.MarkConvRead(conv.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	check(s, a.ID, 0)
	check(s, b.ID, 1)
	reloaded, err := LoadStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	check(reloaded, a.ID, 0)
	check(reloaded, b.ID, 1)
	if err := reloaded.MarkConvRead(conv.ID, "unknown"); err != ErrForbidden {
		t.Fatalf("unexpected access error: %v", err)
	}
}
