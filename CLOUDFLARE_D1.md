# Cloudflare Pages and D1 setup

The Quests page uses a Cloudflare Pages Function at `/api/quests`, backed by the D1 database binding named `DB`. It no longer needs the PHP quest endpoint to run on Cloudflare. Other PHP-backed pages and APIs are unchanged.

Cloudflare D1 is separate from a MySQL database also named `guio_db`. The migrations create the quest tables and seed the sample Baguio quest in D1; updates made only to MySQL will not appear on the Cloudflare-hosted Quests page.

## Create and bind the database

From the project root:

1. Create a D1 database:

   ```sh
   npx.cmd wrangler d1 create guio_db
   ```

2. Copy the returned database ID into `database_id` in `wrangler.toml`.
3. Apply the schema and Baguio quest seed to the remote database:

   ```sh
   npx.cmd wrangler d1 migrations apply guio_db --remote
   ```

4. In Cloudflare Pages, make sure the project uses this `wrangler.toml` and that the D1 binding `DB` points to `guio_db`. If the Pages project is configured through the dashboard, add a D1 binding named `DB` there as well.
5. Redeploy the Pages project. The Quest catalog and QR-based progress requests use the same Pages domain.

For local Pages development in PowerShell, run `npx.cmd wrangler d1 migrations apply guio_db --local`, then `npx.cmd wrangler pages dev .`.

The selected account username is created in D1 the first time a quest is started. To create a focal-person QR code for a destination, run:

```sh
node database/generate_destination_qr.mjs <site_id>
```

Encode the printed payload as a QR code, then run the printed Wrangler command to store its hash in D1. The raw payload is only shown once.
