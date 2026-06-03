# PostgreSQL Replication Manager — Backlog zadań

Wygenerowano na podstawie analizy QA dokumentacji PostgreSQL 16 Logical Replication.
Data: 2026-06-04

---

## KRYTYCZNE — blokują poprawne działanie / mogą powodować utratę danych

### [SEC-01] SQL Injection w nazwach tabel publikacji
- **Plik:** `backend/app/routers/replication.py` — `create_or_update_publication()`
- **Problem:** `config.target.tables` jest wstrzykiwany bezpośrednio do SQL bez sanitizacji
- **Fix:** Walidacja nazw przez listę tabel z bazy lub użycie `quote_ident()` przez asyncpg
- **Agent:** `engineering-skills:senior-security`
- **Priorytet:** P0

### [SEC-02] SQL Injection przez DSN subskrypcji
- **Plik:** `backend/app/routers/replication.py` — `create_or_update_subscription()`
- **Problem:** `config.source_dsn` wstrzykiwany do `CREATE SUBSCRIPTION ... CONNECTION '...'` bez sanitizacji
- **Fix:** Walidacja formatu DSN, dollar-quoting lub parametryzacja
- **Agent:** `engineering-skills:senior-security`
- **Priorytet:** P0

### [BACKEND-01] Brak walidacji `wal_level = logical` na source
- **Plik:** `backend/app/routers/connections.py` — `connect()`
- **Problem:** Publikacja i slot tworzą się poprawnie, ale replikacja nigdy nie ruszy przy `wal_level != logical`
- **Fix:** `SELECT current_setting('wal_level')` w `connect()` i `/connections/test`, zwrócić ostrzeżenie/błąd
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P0

### [BACKEND-02] Brak sprawdzenia REPLICA IDENTITY tabel
- **Plik:** `backend/app/routers/analysis.py` — `list_schemas()`
- **Problem:** Tabele bez PK lub z `REPLICA IDENTITY NOTHING` będą powodować błędy runtime przy UPDATE/DELETE
- **Fix:** Dodać do query `pg_class.relreplident`, zwracać w `TableInfo`; oznaczać w UI jako ⚠️/❌
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P0

### [BACKEND-03] DROP SUBSCRIPTION nie usuwa slotu gdy source niedostępny
- **Plik:** `backend/app/routers/replication.py` — `drop_subscription()`
- **Problem:** Orphaned slot akumuluje WAL bez limitu → ryzyko zapełnienia dysku na source
- **Fix:** Po DROP SUBSCRIPTION — sprawdzić czy slot nadal istnieje na source i usunąć go manualnie
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P0

### [BACKEND-04] Stan aplikacji bez persystencji (memory-only)
- **Plik:** `backend/app/state.py`
- **Problem:** DSN-y i konfiguracja giną przy restarcie kontenera
- **Fix:** Persystencja w pliku JSON lub SQLite (`/data/config.json`), volume w docker-compose
- **Agent:** `engineering-skills:senior-fullstack`
- **Priorytet:** P0

### [BACKEND-05] Brakujący stan `'e'` (error) w mapowaniu `pg_subscription_rel`
- **Plik:** `backend/app/routers/replication.py` — `replication_progress()`
- **Problem:** Stan `srsubstate = 'e'` (error/waiting) nie jest obsługiwany → tabela w błędzie pokazuje się jako `'unknown'`
- **Fix:** Dodać `WHEN 'e' THEN 'error'` do CASE
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P0

---

## WYSOKI — częste problemy operacyjne

### [BACKEND-06] Brak monitoringu `pg_stat_subscription`
- **Plik:** `backend/app/routers/replication.py` — nowy endpoint
- **Problem:** Nie można wykryć crashu workera replikacji (subscription enabled ale worker martwy)
- **Fix:** Nowy endpoint `GET /api/replication/worker-stats` odpytujący `pg_stat_subscription`
- **Kolumny:** `pid`, `last_msg_receive_time`, `latest_end_lsn`, `latest_end_time`, `received_lsn`
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P1

### [BACKEND-07] Brak `pg_stat_replication` na source (lag write/flush/replay)
- **Plik:** `backend/app/routers/replication.py` — nowy endpoint
- **Problem:** Lag liczony tylko przez `pg_wal_lsn_diff`, brak szczegółów `write_lag`/`flush_lag`/`replay_lag`
- **Fix:** Nowy endpoint `GET /api/replication/source-stats` odpytujący source przez pool
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P1

### [BACKEND-08] Brak obsługi konfliktów (SKIP LSN)
- **Plik:** `backend/app/routers/replication.py` — nowe endpointy
- **Problem:** Gdy replikacja zatrzyma się na konflikcie (constraint violation) — brak UI do recovery
- **Fix:**
  - `GET /api/replication/conflicts` — lista subskrypcji z `subenabled=false` + info z `pg_replication_origin_status`
  - `POST /api/replication/skip-lsn` — `ALTER SUBSCRIPTION sub SKIP (LSN '...')`
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P1

### [BACKEND-09] Brak `REFRESH PUBLICATION` na subskrypcji
- **Plik:** `backend/app/routers/replication.py`
- **Problem:** Po dodaniu tabel do publikacji subskrypcja nie zaczyna ich replikować automatycznie
- **Fix:** `POST /api/replication/subscription/{name}/refresh` → `ALTER SUBSCRIPTION sub REFRESH PUBLICATION`
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P1

### [FRONTEND-01] Sekwencje nie są replikowane — brak ostrzeżenia
- **Plik:** `frontend/src/pages/AnalysisPage.tsx`
- **Problem:** Tabele z kolumnami `serial`/`identity` dadzą konflikty PK po failoverze na destination
- **Fix:** Wykrywać `serial`/`identity` przez `pg_attribute.attidentity` / `pg_sequences`, pokazywać ⚠️ w UI
- **Agent:** `engineering-skills:senior-frontend`
- **Priorytet:** P1

### [BACKEND-10] `ALTER PUBLICATION SET TABLE` zamiast DROP+CREATE
- **Plik:** `backend/app/routers/replication.py` — `create_or_update_publication()`
- **Problem:** DROP+CREATE publikacji przerywa replikację wszystkich tabel na czas rekonf iguracji
- **Fix:** Przy update użyć `ALTER PUBLICATION pub SET TABLE ...` + `ALTER SUBSCRIPTION sub REFRESH PUBLICATION`
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P1

---

## ŚREDNI — kompletność funkcjonalna

### [BACKEND-11] Race condition w `reset_replication`
- **Plik:** `backend/app/routers/replication.py` — `reset_replication()`
- **Problem:** Brak transakcyjności — jeśli `CREATE SUBSCRIPTION` się nie powiedzie po DROP, subskrypcja jest utracona
- **Fix:** Zapisać config przed DROP, retry z backoffem na CREATE, rollback info w response
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P2

### [FRONTEND-02] Brak obsługi tabel partycjonowanych
- **Plik:** `frontend/src/pages/AnalysisPage.tsx`
- **Problem:** Tabele partycjonowane pokazują się jak zwykłe bez oznaczenia; leaf-partitions muszą istnieć na dest
- **Fix:** Oznaczać `relkind = 'p'` (partitioned) w UI, informować o wymaganej strukturze na dest
- **Agent:** `engineering-skills:senior-frontend`
- **Priorytet:** P2

### [FRONTEND-03] Brak eksportu schematu DDL
- **Plik:** `frontend/src/pages/ReplicationSetupPage.tsx`
- **Problem:** Schematy nie są replikowane — użytkownik musi ręcznie synchronizować DDL
- **Fix:** Przycisk "Show DDL instructions" z wyjaśnieniem komendy `pg_dump --schema-only`
- **Agent:** `engineering-skills:senior-frontend`
- **Priorytet:** P2

### [FRONTEND-04] Brak ostrzeżenia o TRUNCATE + foreign keys
- **Plik:** `frontend/src/pages/ReplicationSetupPage.tsx`
- **Problem:** TRUNCATE na tabelach z FK do tabel spoza subskrypcji spowoduje błąd replikacji
- **Fix:** Sprawdzić FK między wybranymi tabelami a resztą, pokazać listę ryzyk przy Apply
- **Agent:** `engineering-skills:senior-frontend`
- **Priorytet:** P2

### [FRONTEND-05] Brak informacji o rozmiarze danych przed inicjalnym synciem
- **Plik:** `frontend/src/pages/ReplicationSetupPage.tsx`
- **Problem:** Przy `copy_data = true` dla dużych baz użytkownik nie wie ile danych zostanie skopiowanych
- **Fix:** Podsumowanie łącznego rozmiaru wybranych tabel przed kliknięciem "Apply"
- **Agent:** `engineering-skills:senior-frontend`
- **Priorytet:** P2

---

## NISKI — jakość i UX

### [SQL-01] Błędny JOIN na `pg_class` w analysis.py
- **Plik:** `backend/app/routers/analysis.py` — `list_schemas()`
- **Problem:** `JOIN pg_class c ON c.relname = t.table_name` — nie uwzględnia schematu, błędne wyniki przy tabelach o tej samej nazwie w różnych schematach
- **Fix:** Dodać `AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)`
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P3

### [SQL-02] `pg_publication_namespace` nie istnieje przed PG15
- **Plik:** `backend/app/routers/replication.py` — `list_publications()`
- **Problem:** JOIN na `pg_publication_namespace` spowoduje błąd na PG 14 i niżej
- **Fix:** Conditional JOIN oparty o wykrytą wersję PG, lub `LEFT JOIN` z obsługą błędu
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P3

### [SQL-03] NULL lag_bytes przy inactive slot
- **Plik:** `backend/app/routers/replication.py` — `list_slots()`
- **Problem:** `pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)` zwraca NULL gdy slot nieaktywny
- **Fix:** `COALESCE(..., 0)` lub obsługa NULL w modelu Pydantic
- **Agent:** `engineering-skills:senior-backend`
- **Priorytet:** P3

### [FRONTEND-06] Brak global health status — subskrypcja w błędzie
- **Plik:** `frontend/src/pages/StatusPage.tsx`
- **Problem:** Subskrypcja wyłączona przez `disable_on_error` nie pokazuje powodu wyłączenia
- **Fix:** Badge z "disabled (conflict)" + link do sekcji konfliktów
- **Agent:** `engineering-skills:senior-frontend`
- **Priorytet:** P3

### [SEC-03] DSN z hasłem widoczny w logach i w `/connections/status`
- **Plik:** `backend/app/routers/connections.py`, `backend/app/state.py`
- **Problem:** Plaintext hasła w DSN mogą wyciec przez logi FastAPI i endpoint status
- **Fix:** Maskowanie hasła (`postgresql://user:***@host/db`) w response i logach
- **Agent:** `engineering-skills:senior-security`
- **Priorytet:** P3

### [FRONTEND-07] Brak instrukcji pg_hba.conf przy błędzie połączenia
- **Plik:** `frontend/src/pages/ConnectionPage.tsx`
- **Problem:** Błąd połączenia replikacyjnego jest ogólny — użytkownik nie wie że może brakować wpisu w pg_hba.conf
- **Fix:** Przy błędzie "no pg_hba.conf entry" — pokazać konkretną instrukcję konfiguracji
- **Agent:** `engineering-skills:senior-frontend`
- **Priorytet:** P3

---

## Podsumowanie

| Priorytet | Liczba zadań | Agenci |
|-----------|-------------|--------|
| P0 — Krytyczne | 7 | senior-security (×2), senior-backend (×4), senior-fullstack (×1) |
| P1 — Wysoki | 5 | senior-backend (×4), senior-frontend (×1) |
| P2 — Średni | 5 | senior-backend (×1), senior-frontend (×4) |
| P3 — Niski | 7 | senior-backend (×4), senior-frontend (×2), senior-security (×1) |
| **RAZEM** | **24** | |

## Przydzielenie do agentów

| Agent | Zadania |
|-------|---------|
| `engineering-skills:senior-security` | SEC-01, SEC-02, SEC-03 |
| `engineering-skills:senior-backend` | BACKEND-01..11, SQL-01..03 |
| `engineering-skills:senior-frontend` | FRONTEND-01..07 |
| `engineering-skills:senior-fullstack` | BACKEND-04 (persystencja stanu) |
