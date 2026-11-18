package persistence

import (
	"context"
	"github.com/navidrome/navidrome/model"
	"github.com/pocketbase/dbx"
)

func CreateSiteIdentity(ctx context.Context, store model.DataStore, issuer, subject, userID, email, name string) error {
	s := store.(*SQLStore)
	_, err := s.db.NewQuery("INSERT INTO site_identity(issuer,subject,user_id,email,name) VALUES({:issuer},{:subject},{:user},{:email},{:name})").Bind(dbx.Params{"issuer": issuer, "subject": subject, "user": userID, "email": email, "name": name}).WithContext(ctx).Execute()
	return err
}
