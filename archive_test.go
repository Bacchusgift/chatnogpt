package main

import "testing"

func TestArchiveExpiresOnlyForOneMember(t *testing.T) {
	s, err := newFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, _, err := s.CreateUser("archive_a", "Archive A", "password123")
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := s.CreateUser("archive_b", "Archive B", "password123")
	if err != nil {
		t.Fatal(err)
	}
	c := s.CreateConv(a, "shared")
	if _, err := s.JoinConv(b, c.Code, "shared"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetConvArchived(c.ID, a.ID, true); err != nil {
		t.Fatal(err)
	}
	if got := s.ListConvs(a.ID); len(got) != 1 || got[0].ArchivedAt == 0 {
		t.Fatalf("archive missing: %+v", got)
	}
	if err := s.SetConvArchived(c.ID, a.ID, false); err != nil {
		t.Fatal(err)
	}
	if got := s.ListConvs(a.ID); len(got) != 1 || got[0].ArchivedAt != 0 {
		t.Fatalf("restore failed: %+v", got)
	}
	if err := s.SetConvArchived(c.ID, a.ID, true); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.d.Convs[c.ID].Members[a.ID].ArchivedAt = now() - archiveRetentionSeconds - 1
	s.mu.Unlock()
	if err := s.PurgeExpiredArchives(); err != nil {
		t.Fatal(err)
	}
	if got := s.ListConvs(a.ID); len(got) != 0 {
		t.Fatalf("expired archive still visible: %+v", got)
	}
	if got := s.ListConvs(b.ID); len(got) != 1 {
		t.Fatalf("other member lost conversation: %+v", got)
	}
	if err := s.SetConvArchived(c.ID, a.ID, false); err == nil {
		t.Fatal("expired membership was restored")
	}
}
