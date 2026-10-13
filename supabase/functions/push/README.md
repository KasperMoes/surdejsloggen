Edge function "push" er udrullet direkte i Supabase-projektet.
Den kaldes af databasen (triggerne push_on_friendship og push_on_bake) og sender
web push til abonnenter i tabellen push_subscriptions.
