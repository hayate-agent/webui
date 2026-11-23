# WebUI-Dashboard-Channels: Recherche (Stand 2026-11-23)

## Wunsch
- Im WebUI Konversationen als "Home-Channel" kennzeichnen (wie bei Matrix/Slack). Es kann mehrere geben.
- Ein solcher Channel ist kein echter Chat, sondern ein dauerhaftes, sich aktualisierendes Dashboard.
- Der Chat dazu ist ein schwebendes Seitenfenster und wirkt auf das Dashboard.
- Eine Bibliothek soll UIs dynamisch erzeugen und streamen können (oder eine DSL für Layouts, die stehen bleiben).
- OpenUI soll im Zweifel auch in der normalen Chat-Ausgabe funktionieren.

## Kandidaten (Daten vom 2026-11-23, npm/GitHub/Doku)

| | OpenUI (Thesys) | json-render (Vercel Labs) | A2UI (Google) | MCP Apps |
|---|---|---|---|---|
| Was es ist | Zeilenbasierte Sprache "OpenUI Lang" plus React-Runtime | JSON-Spec, Streaming als JSONL-Patches (RFC 6902) | Protokoll (createSurface, updateComponents, updateDataModel, deleteSurface), Renderer für Web/Lit/React | Tool liefert `ui://`-HTML, läuft in sandboxed iframe |
| Lizenz | MIT | Apache-2.0 | Apache-2.0 | MIT |
| Paket | `@openuidev/react-lang` 1.1.1 (1,1 Mio./Woche, 15,4k Sterne, letzter Push heute) | `@json-render/core` + `react` + `shadcn` 0.23.2 (4,2 Mio./Woche) | `@a2ui/react` 0.15.0 (Protokoll v1.0) | `@modelcontextprotocol/ext-apps` 2.0.4 |
| Datenabruf und Aktualisierung | Eingebaut: `Query(tool, args, default, refreshSekunden)`, `Mutation`, reaktive `$variablen`, Filter laden ohne Modellaufruf | State plus Aktionen; Datenabruf nicht eingebaut | Datenmodell-Updates vom Agenten, Aktionen zurück an den Agenten | beliebiges HTML, eigene Logik |
| Eigene Komponenten | `defineComponent` (zod) + `createLibrary` | `defineCatalog`; fertiger shadcn-Katalog (36 Komponenten) | Katalog, Client mappt auf eigene Komponenten | frei (HTML) |
| Inkrementelle Änderung | ja ("Incremental Editing") | ja (Patches) | ja (updateComponents) | nein (neues HTML) |
| Sicherheit | nur eigene Komponenten, Parser verwirft Ungültiges | nur Katalog | nur Katalog | iframe-Sandbox, volle Freiheit im Frame |

Bewertungshinweis: Die Vergleichstabelle (Token-Verbrauch 1x gegen 3x, "Built-in data fetching") stammt von OpenUI selbst. Ich habe sie nicht nachgemessen.

Nicht relevant als Bibliothek: Open WebUI bettet HTML nur als iframe ein (Tool gibt `HTMLResponse` zurück). Das ist das MCP-Apps-Prinzip, keine UI-Bibliothek.

## Was zu unserem Wunsch passt
- **OpenUI Lang** deckt Dashboards am besten ab: Das Modell schreibt das Layout einmal. Danach holt die Laufzeit Daten selbst, auch periodisch, ohne Modell. Filter und Refresh-Knöpfe kosten keine Tokens. Das Dashboard bleibt stehen, und Änderungen gehen als Patch.
- Dieselbe Laufzeit rendert auch Ausgaben in der normalen Chat-Nachricht. Ein Block in der Nachricht und ein ganzes Dashboard sind dieselbe Technik.
- **json-render** ist die Alternative: Es bringt fertige shadcn-Komponenten mit und passt zu unserem Stack. Es hat aber keinen eingebauten Datenabruf. Den Refresh müssten wir selbst bauen.
- **A2UI** passt gut zu "mehrere Dashboards" (Surfaces) und zum Agent-Protokoll. Das Datenmodell wird aber vom Agenten gepusht, nicht vom Browser geholt.
- **MCP Apps / iframe-HTML** ist am freiesten, aber am schwersten zu sichern und stilistisch nicht konsistent mit shadcn.

## Befunde zu unserem Stack (geprüft am Paket-Inhalt)
- `@openuidev/react-lang` hat im Browser-Code **keine** Telemetrie und keine Style-Injektion. Es hängt an `@openuidev/lang-core`.
- **Telemetrie:** `lang-core` führt beim Installieren ein `postinstall` aus (anonyme Installations-ID, Versionen, CI/Docker). Wir installieren mit `--ignore-scripts`. Zusätzlich abschaltbar mit `OPENUI_TELEMETRY_DISABLED=1` oder `DO_NOT_TRACK=1`. Laufzeit-Telemetrie ist laut Doku standardmäßig aus und läuft nur serverseitig.
- **`@openuidev/react-ui`** (fertige Komponenten) nutzt `goober` (CSS-in-JS). Das würde zur Laufzeit Styles einfügen, und unsere CSP verbietet Inline-Style. Deshalb nicht verwenden. Stattdessen eigene Komponenten aus unseren shadcn-Quellen registrieren.
- Die Doku bewirbt "Gateway", "Autofix" und eine Dashboard-API des Anbieters. Wir brauchen nichts davon: Das Modell ist unser Agent, die Validierung macht der Parser lokal. **Ungeprüft:** ob die "Dashboards"-API zwingend den Gateway nutzt. Das spielt für uns keine Rolle, solange wir nur `react-lang` einsetzen.

## Sicherheitskern (gilt für jede Bibliothek)
Eine Dashboard-Abfrage läuft im Browser und ruft Tools auf. Der `toolProvider` darf deshalb **nicht** beliebige Agenten-Tools freigeben:
1. Allowlist nur für lesende Datentools, die der Agent des Channels freigibt (owner- und session-gebunden, über den bestehenden Relay-Pfad mit opId-Ledger).
2. `Mutation` nur mit sichtbarer Bestätigung und nur für ausdrücklich freigegebene Tools.
3. Ergebnisdaten sind unvertrauenswürdig (Prompt-Injection über Daten). Sie werden nie als Anweisung an das Modell zurückgegeben.
4. Dashboard-Definition und Daten bleiben im Cache des WebUI beschränkt. Die Quelle der Wahrheit ist der Agent.

## Empfohlene Architektur
- **Channel-Typ "dashboard":** Eine Konversation mit Kennzeichnung `kind: dashboard`. Mehrere möglich. Der Agent speichert die aktuelle Dashboard-Definition (OpenUI Lang) als Teil der Konversation, nicht nur als Chat-Text.
- **Darstellung:** Dashboard-Fläche (Raster) plus schwebendes, einklappbares Chatfenster am Rand. Der Chat bearbeitet das Dashboard über inkrementelle Änderungen.
- **Normaler Chat:** Ein Codeblock `openui` in einer Nachricht wird mit derselben Laufzeit gerendert (gleiche Komponenten, gleiche Allowlist).
- **Komponenten:** eigene `createLibrary` aus unseren shadcn-Bausteinen (Card, Badge, Alert, Table, Metric, Chart, Select, Button). Keine `react-ui`-Komponenten.
- **Raster/Anordnung (später, optional):** `react-grid-layout` 2.3.0 (MIT, 6,2 Mio./Woche) oder `gridstack`, falls du Widgets selbst verschieben und skalieren willst. Das Layout wird getrennt von der Dashboard-Definition gespeichert.

## Vorgeschlagene Umsetzung in Schritten (je ein PR, getestet, mit Mutationsprüfung)
1. **Spike:** `@openuidev/react-lang` im Bundle. Messen: Größe, CSP-Verträglichkeit (kein Inline-Style), Rendern eines Beispiels aus eigenen shadcn-Komponenten, `Query` mit Auto-Refresh gegen einen Fake-`toolProvider`. Entscheidung gegen json-render nur, wenn hier etwas hart scheitert.
2. **Chat-Block:** `openui`-Block in Nachrichten, mit Allowlist (nur Lesen).
3. **Channel-Typ "dashboard":** Kennzeichnung, Liste, Anzeige. Dashboard-Definition beim Agenten gespeichert, per WebSocket gestreamt (bestehendes Protokoll).
4. **Schwebender Chat:** Eingaben ändern das Dashboard inkrementell.
5. **Datentools:** Allowlist pro Agent, Bestätigung für Mutationen.
6. **Home-Channels:** Wie bei Matrix/Slack auch im WebUI definierbar (offen: Ich habe die bestehende Home-Channel-Logik für Matrix/Slack noch nicht gelesen. Das ist der erste Punkt in Schritt 3).

## Offene Fragen (mit meiner Standardannahme)
- Wer liefert die Daten? Annahme: der Agent des Channels über freigegebene Lese-Tools, nicht das Modell.
- Soll das Dashboard auch ohne offenen Browser aktuell bleiben? Annahme: nein, es lädt beim Öffnen und solange es offen ist.
- Dürfen Dashboards Aktionen auslösen (Mutationen)? Annahme: ja, aber nur mit Bestätigung und freigegebenen Tools.

---

## Spike result (2026-11-23, step 1)

Branch `spike/openui-lib`. `@openuidev/react-lang` 1.1.1 installed with `--ignore-scripts` (the
`lang-core` telemetry postinstall never runs). Test: `test/dashboard-spike.browser.mjs`, run in a
real browser against the dashboard's real CSP.

**Works**
- Own shadcn components (`Stack`, `Panel`, `Metric`, `Tag`, `Table`, `Btn`, `Notice`) registered with
  `createLibrary`; nothing from `@openuidev/react-ui`. Tailwind utilities and the shadcn `Badge`
  classes apply (checked by computed style).
- `Query(tool, args, default, refreshSeconds)` refreshes itself against a fake `toolProvider`
  without any model (several calls within seconds).
- An unknown component in the program is dropped, the rest still renders.
- Actions: `Btn` fires `@Run(query)` and `Action([@Run(mutation)])` via `useTriggerAction()`.
- Tool policy and switch implemented and tested (`docs/DASHBOARD-TOOLS.md`, `HAYATE_DASHBOARD_TOOLS`,
  default `strict`). Through the real renderer a generated `Mutation` in strict mode asks the
  operator, is declined, and nothing reaches the agent.

**Hard finding 1 – CSP (found by the test, fixed)**
The library injects a `<style>` element for its default loading spinner. Our CSP (`style-src 'self'`)
blocks it. Fix: pass our own `queryLoader` (Tailwind `animate-spin`). The test fails again when that
is removed (mutation checked). That `<style>` element is the only CSP violation seen in the test.

**Hard finding 2 – size**
`lang-core` imports the full `zod/v4`: about 444 KiB minified of the ~800 KiB the dashboard bundle
contains (react-dom is shared with `app.js`). `app.js` is 826 KiB today. A stand-alone dashboard
bundle is 799 KiB minified / 204 KiB gzip. Consequence for the next step: load the dashboard code
**lazily** (separate entry, loaded only when a dashboard or an `openui` block is shown), not in the
main bundle. `zod/mini` is 12 KiB, but `lang-core` does not use it.

**Verdict**: OpenUI Lang stays the choice; json-render is not needed. The next step needs a second
esbuild entry with code splitting and a server whitelist entry for the chunk.

**Gotchas for the next steps**
- `Btn` must use `action()` in its schema and `useTriggerAction()`; a plain `props.action()` is not a function.
- Node tests with `fetch` need a fresh port per server (keep-alive resets after a restart).
