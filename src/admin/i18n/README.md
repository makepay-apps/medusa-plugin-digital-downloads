# Admin translations

`index.ts` registers the plugin namespace and `json/en.json` is the canonical
English catalog used by every Digital Downloads Admin route and widget. Add a
locale by preserving the same nested keys and exporting it from `index.ts`.

Operational state names, delivery modes, and destructive-action confirmations
must remain consistent with the API enums and the merchant guide.
