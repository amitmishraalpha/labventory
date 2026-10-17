# Labventory

A production-oriented chemical inventory foundation for research laboratories. The current slice includes a responsive inventory dashboard, bottle-level search and detail workflow, import review entry point, and a normalized Supabase schema.

## Run locally

```bash
npm install
npm run dev
```

The UI currently uses representative local data so the interaction model can be reviewed before connecting Supabase. Add a Supabase client in `src/services/` and move the sample queries to the tables defined in `supabase/schema.sql`.

The visible inventory reads from Supabase. `supabase/migrations/20261017_seed_visible_inventory.sql` contains development-only sample records and must not be run against a production database. The production app uses existing `chemicals`, `bottles`, `locations`, `suppliers`, and `transactions` rows.

## Authentication setup

Authentication is invitation-only when the Supabase variables are present. Copy `.env.example` to `.env.local`, fill in the project URL and public anon key, then run the base schema followed by `supabase/migrations/20261013_auth_rbac_usage.sql`.

Provision the one Admin securely in the Supabase Dashboard or with the Supabase CLI: create an Auth user with an email you control, create the matching `profiles` row with `role = 'ADMIN'` and `account_status = 'active'`, then set `system_settings` to `{ "key": "designated_admin", "value": { "user_id": "THE_AUTH_USER_UUID" } }`. Disable public sign-ups in Supabase Auth settings. The Admin password is intentionally not stored in this repository; set it during Auth user creation or use Supabase password recovery.

There is no valid Admin email/password in this codebase yet because no Supabase project credentials or account have been provisioned. Use the email and password you set in the Supabase Dashboard. Never put that password in `.env`, React code, or Git.

### Invite Researchers

Deploy the trusted invitation function after applying the auth migration:

```bash
npx supabase login
npx supabase link --project-ref uonazsahdemakkchmarr
npx supabase functions deploy invite-researcher --no-verify-jwt
```

The function uses Supabase's server-side `auth.admin.inviteUserByEmail` API and verifies the caller is the active designated Admin. The service-role key is never included in the frontend. Once deployed, open **User Management** in the Admin sidebar, enter the researcher's email, and send the invitation.

## Activity log and spreadsheet import

`supabase/migrations/20261018090000_activity_log_and_inventory_import.sql` creates the append-only `activity_log`, the Admin profile policies, `activate_invited_user()`, the `inventory_import_batches` table, and the `import_inventory_batch` RPC. It is idempotent; review it and apply it to a development project before production.

Imports run in **Research Management → Import**: upload `.xlsx`/`.csv` → map columns → validate (a server-side dry run that rolls back) → confirm. The RPC re-validates every row, checks that the caller is the active designated Admin, and writes the whole batch in one transaction. Each row becomes one bottle with a `STOCK_IN` transaction (never `USAGE`), and the import is logged as `INVENTORY_IMPORT`. Existing bottle IDs are rejected, never overwritten. Re-submitting the same request returns the original result, and re-uploading an identical file is blocked.

The app uses client-side routes (`/`, `/inventory`, `/chemicals`, `/admin`). Static hosting must rewrite unknown paths to `index.html`.

## Data model

`chemicals` is the master identity record. `bottles` is the physical inventory record, allowing multiple bottles for the same CAS number with independent quantities, suppliers, locations, expiry dates, and QR IDs. `transactions` is append-only and records before/after quantity, movement locations, actor, and reason. Raw import fields should be retained in `bottles.raw_source` and reviewed before confirmation.

## Next production steps

1. Create a Supabase project, run the schema migration, configure Auth and the private SDS storage bucket.
2. Add a locked `record_usage` / `transfer_bottle` RPC for atomic quantity and location changes.
3. Connect the React services to Supabase Auth and generated database types.
4. Add PapaParse/XLSX import preview, PubChem enrichment confirmation, QR scanning, and Playwright coverage.

Never expose a Supabase service-role key in the browser. Use environment variables for public URL/anon key and server-side functions for privileged operations.
