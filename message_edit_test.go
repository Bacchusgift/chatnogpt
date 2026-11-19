package main

import "testing"

func TestOwnMessageEditAndRecallPersist(t *testing.T) {
	st, err := OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, _, err := st.CreateUser("edit-alice", "Edit Alice", "password123")
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := st.CreateUser("edit-bob", "Edit Bob", "password123")
	if err != nil {
		t.Fatal(err)
	}
	conv, err := st.NewConvWith(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	msg, err := st.AddMessage(conv.ID, a.ID, a.Nickname, "old", "edit-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpdateOwnMessage(conv.ID, b.ID, msg.ID, "stolen", false); err != ErrForbidden {
		t.Fatalf("other user edit: %v", err)
	}
	if _, err := st.UpdateOwnMessage(conv.ID, a.ID, msg.ID, "new", false); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpdateOwnMessage(conv.ID, a.ID, msg.ID, "", true); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpdateOwnMessage(conv.ID, a.ID, msg.ID, "revived", false); err != ErrForbidden {
		t.Fatalf("edit recalled: %v", err)
	}
	reloaded, err := OpenFileStore(st.Dir())
	if err != nil {
		t.Fatal(err)
	}
	msgs, err := reloaded.HistoryMessages(conv.ID, b.ID, 0, 0, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].Content != recalledMessageText {
		t.Fatalf("reloaded messages: %+v", msgs)
	}
}
