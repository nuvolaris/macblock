# MacBlock GPU Authorization Watchdog

## Scopo

MacBlock protegge una installazione Bestia/Nuvolaris verificando che le GPU
presenti sul nodo siano autorizzate dal servizio centrale Nuvolaris.

Il componente da implementare in questo repository e' un watchdog Kubernetes
installato nel cluster k3s locale. Il watchdog:

- rileva i seriali e gli identificativi delle GPU NVIDIA visibili sul nodo;
- invia periodicamente gli identificativi al servizio esterno:
  `https://api.nuvolaris.io/v1/serials_check`;
- considera l'endpoint di verifica una dipendenza di licenza/sicurezza esterna;
- dopo 5 tentativi consecutivi falliti senza una autorizzazione ancora valida,
  scala a zero le risorse applicative del namespace `nuvolaris`;
- continua a riconciliare lo stato bloccato, cosi' le risorse non tornano
  disponibili finche' la verifica non viene ripristinata o non viene eseguita
  una procedura esplicita di recovery;
- viene installato come componente critico di k3s e non vive nel namespace
  `nuvolaris`, altrimenti verrebbe spento dalla sua stessa azione di blocco.

L'implementazione server-side di
`https://api.nuvolaris.io/v1/serials_check` non e' in scope per questo
repository.
Questa specifica definisce pero' il contratto minimo atteso dal client, in modo
che il futuro endpoint possa essere implementato senza ambiguita'.

## Ambito

In scope:

- manifest Kubernetes e/o task installer per installare il watchdog;
- immagine runtime pullabile del watchdog tramite subrepo root `macblock`;
- mock API di sviluppo per prove end-to-end del contratto
  `api.nuvolaris.io`;
- discovery GPU sul nodo Bestia;
- chiamata HTTPS al servizio Nuvolaris di verifica seriali;
- gestione del contatore dei fallimenti;
- enforcement sul namespace `nuvolaris`;
- protezione operativa contro cancellazione accidentale del watchdog;
- comandi `ops bestia macblock ...` di installazione, stato, test e recovery;
- documentazione operativa e criteri di validazione.

Fuori scope:

- implementazione del backend pubblico `api.nuvolaris.io`;
- portale commerciale/licensing;
- UI finale di amministrazione, salvo eventuale aggancio futuro nel menu
  installer;
- blocco hardware a livello BIOS/driver;
- enforcement su namespace diversi da `nuvolaris`, salvo estensioni esplicite.

## Separazione repository

MacBlock e' diviso in due responsabilita' distinte.

Il repository root `bestia-installer` include il subrepo:

```text
macblock/ -> https://github.com/nuvolaris/macblock
```

Questo subrepo contiene solo cio' che riguarda runtime e build dell'immagine:

- `Containerfile`;
- sorgente runtime copiato nell'immagine;
- workflow GitHub Actions per pubblicare GHCR;
- specifica dell'immagine.

Le immagini pubbliche iniziali sono:

```text
ghcr.io/nuvolaris/macblock:0.1.0
ghcr.io/nuvolaris/bestia-macblock:0.1.0
```

La prima e' l'immagine primaria; la seconda resta un alias di compatibilita'.

Il modulo:

```text
olaris-bestia/macblock/
```

contiene invece solo installazione e configurazione operativa:

- comandi `ops bestia macblock ...`;
- render del manifest k3s AddOn;
- Secret, RBAC, ConfigMap di stato e opzioni di installazione;
- mock API di sviluppo.

Il manifest di produzione deve quindi usare un'immagine GHCR pullabile e non
deve dipendere da codice runtime montato tramite ConfigMap generata localmente.

## Classificazione host e endpoint

`https://api.nuvolaris.io/v1/serials_check` e' un endpoint esterno di
licensing/controllo Nuvolaris, non un servizio interno k3s e non un host
browser-facing dell'installazione locale.

L'URL deve essere configurabile, per esempio tramite:

- valore di config Bestia, ad esempio `BESTIA_MACBLOCK_API_URL`;
- Secret Kubernetes montato nel namespace del watchdog;
- default di release impostato a
  `https://api.nuvolaris.io/v1/serials_check`.

Il valore non deve essere confuso con:

- `OPS_APIHOST`, che rappresenta l'apihost del cluster Nuvolaris locale;
- host applicativi come `system.miniops.me`, `console.miniops.me` o
  `trustable.miniops.me`;
- service DNS interni come `ollama.nuvolaris.svc.cluster.local`.

Il watchdog deve usare HTTPS con verifica TLS abilitata. Qualsiasi opzione di
debug per disabilitare la verifica TLS deve essere esclusa dalle build di
release o richiedere una variabile esplicita di sviluppo non documentata come
flusso normale.

## Architettura runtime

MacBlock deve essere installato fuori dal namespace `nuvolaris`.

Namespace consigliato:

```text
kube-system
```

Motivazione:

- il watchdog deve sopravvivere quando il namespace `nuvolaris` viene scalato a
  zero;
- `kube-system` e' gia' il namespace dei componenti critici k3s;
- il pod puo' usare `priorityClassName: system-cluster-critical`;
- l'installazione puo' essere riconciliata dal controller k3s AddOn se il
  manifest viene posizionato in `/var/lib/rancher/k3s/server/manifests`.

Forma consigliata:

- `Deployment/bestia-macblock` in `kube-system`, con `replicas: 1`;
- `ServiceAccount/bestia-macblock`;
- `Role` o `ClusterRole` con permessi minimi;
- `RoleBinding`/`ClusterRoleBinding`;
- `ConfigMap/bestia-macblock-state` per stato non sensibile;
- `Secret/bestia-macblock-auth` per API key verso il servizio esterno;
- `PodDisruptionBudget` con `minAvailable: 1`;
- `priorityClassName: system-cluster-critical`;
- tollerazioni per nodi control-plane/master k3s;
- eventuale `RuntimeClass`/device access NVIDIA se necessario per leggere la
  GPU dal container.

Il manifest sorgente del watchdog deve essere trattato come parte dei servizi
critici k3s:

```text
/var/lib/rancher/k3s/server/manifests/bestia-macblock.yaml
```

Su k3s, i manifest in questa directory vengono riconciliati dal deploy
controller locale. Questo non rende il componente invulnerabile a un utente
root, ma protegge da cancellazioni accidentali via `kubectl delete` e consente
il ripristino automatico del workload.

## Discovery GPU

Il watchdog deve rilevare tutte le GPU NVIDIA visibili al nodo Bestia.

Metodo primario:

```bash
nvidia-smi --query-gpu=index,name,uuid,serial,pci.bus_id --format=csv,noheader
```

Campi minimi da raccogliere:

- indice GPU locale;
- nome modello;
- UUID GPU;
- seriale;
- PCI bus id;
- hostname del nodo Kubernetes;
- architettura host (`amd64`/`arm64`);
- versione del watchdog;
- versione installer/Bestia quando disponibile.

Regole:

- il seriale GPU e' l'identificativo principale di autorizzazione;
- GPU multiple devono essere inviate tutte nella stessa richiesta;
- se una GPU non espone il seriale e `nvidia-smi` restituisce valori come
  `N/A`, il watchdog deve inviare comunque UUID e PCI bus id, ma la decisione
  resta al server;
- se il comando `nvidia-smi` non e' disponibile, fallisce o non vede GPU, il
  controllo e' considerato fallito, salvo configurazione esplicita di sviluppo;
- possono essere usati identificativi derivati dal MAC address di rete come
  sostituti del seriale GPU ma solo di schede di rete fisiche.

L'immagine del watchdog deve includere solo gli strumenti necessari. Se si usa
una immagine CUDA/NVIDIA per avere `nvidia-smi`, deve essere fissata a un tag
esplicito e supportare le architetture Bestia previste.

## Contratto API client-server

Il watchdog deve inviare una richiesta HTTPS `POST` al servizio di verifica.

Endpoint predefinito:

```text
POST https://api.nuvolaris.io/v1/serials_check
```

Request JSON consigliata:

```json
{
  "installation_id": "bestia-...",
  "cluster_uid": "...",
  "node_name": "...",
  "hostname": "...",
  "watchdog_version": "0.1.0",
  "bestia_version": "2.x",
  "timestamp": "2026-05-27T00:00:00Z",
  "gpus": [
    {
      "index": 0,
      "name": "NVIDIA ...",
      "uuid": "GPU-...",
      "serial": "...",
      "pci_bus_id": "00000000:01:00.0"
    }
  ]
}
```

Response JSON minima attesa:

```json
{
  "authorized": true,
  "status": "allowed",
  "lease_id": "...",
  "lease_signature": "...",
  "valid_until": "2026-05-28T00:00:00Z",
  "reason": "ok"
}
```

Response di blocco:

```json
{
  "authorized": false,
  "status": "denied",
  "reason": "gpu_serial_not_allowed"
}
```

Semantica:

- `authorized: true` consente al namespace `nuvolaris` di rimanere attivo;
- `valid_until` definisce una lease temporanea firmata dal backend e valida per
  il periodo restituito;
- `lease_signature` deve permettere al client di verificare localmente
  l'autenticita' della lease;
- mentre una lease valida non e' scaduta, errori transitori di rete non devono
  far scattare immediatamente il blocco;
- `authorized: false` e' un fallimento hard e incrementa il contatore;
- HTTP `401`, `403` o risposta firmata non valida sono fallimenti hard;
- timeout, DNS failure, TLS failure e HTTP `5xx` sono fallimenti transitori,
  ma diventano enforcement quando non esiste una lease ancora valida e si
  raggiungono 5 tentativi consecutivi;
- response non JSON o schema incompleto devono essere trattati come fallimento.

Autenticazione:

- il watchdog deve autenticarsi verso il servizio con API key;
- la API key deve vivere in `Secret/bestia-macblock-auth`;
- API key e payload sensibili non devono essere stampati nei log;
- rotazione credenziali deve essere possibile aggiornando il Secret e
  riavviando/ricaricando il pod.

Timeout e retry:

- timeout singola chiamata: 10 secondi di default;
- intervallo verifica: 60 secondi di default;
- jitter casuale raccomandato per evitare storm dopo riavvii;
- massimo fallimenti consecutivi prima dell'enforcement: 5;
- i valori devono essere configurabili da ConfigMap, mantenendo 5 come default
  di prodotto.

## Stato persistente

Il contatore dei fallimenti non deve vivere solo in memoria, perche' un restart
del pod non deve azzerare il rischio.

Stato minimo in `ConfigMap/bestia-macblock-state`:

- `consecutive_failures`;
- `last_success_at`;
- `last_failure_at`;
- `last_failure_reason`;
- `blocked`;
- `blocked_at`;
- `last_authorized_lease_until`;
- snapshot delle repliche originali scalate a zero;
- versione schema stato.

Lo stato non deve contenere API key o segreti.

Regole:

- ogni verifica riuscita azzera `consecutive_failures`;
- ogni fallimento hard incrementa `consecutive_failures`;
- ogni fallimento transitorio incrementa `consecutive_failures` solo se non
  esiste una lease valida;
- se `blocked=true`, il watchdog continua a riconciliare il namespace
  `nuvolaris` a zero;
- un nuovo successo dopo blocco deve attivare l'auto-restore se la lease
  firmata e' valida;
- il restore manuale resta disponibile per procedure amministrative e recovery
  controllato.

## Enforcement sul namespace nuvolaris

Quando `consecutive_failures >= 5` e non esiste una lease valida, il watchdog
entra in stato bloccato.

Azione primaria:

```text
scale-to-zero namespace nuvolaris
```

Risorse da gestire:

- `Deployment` in `nuvolaris`: salvare replica count e impostare `replicas: 0`;
- `StatefulSet` in `nuvolaris`: salvare replica count e impostare
  `replicas: 0`;
- `ReplicaSet` non controllati da Deployment: salvare replica count e
  impostare `replicas: 0`;
- `CronJob`: salvare `spec.suspend` e impostare `spec.suspend: true`;
- `Job` attivi: opzionalmente sospendere/eliminare solo se previsto dal design
  del workload, documentando la scelta;
- `HorizontalPodAutoscaler`: salvare manifest o spec e neutralizzare la
  riscalata automatica;
- pod orfani non gestiti: rilevare e riportare nello status, con eventuale
  eliminazione solo se esplicitamente abilitata.

Regole HPA:

- non assumere che `minReplicas: 0` sia disponibile o sufficiente;
- prima di scalare i workload, salvare gli HPA che targettano workload in
  `nuvolaris`;
- durante lo stato bloccato, impedire che gli HPA riportino repliche sopra
  zero, tramite sospensione/rimozione controllata o riconciliazione continua;
- il restore manuale deve ricreare o ripristinare gli HPA salvati.

Annotazioni consigliate sulle risorse modificate:

```text
bestia.nuvolaris.io/macblock-managed=true
bestia.nuvolaris.io/macblock-blocked-at=<timestamp>
bestia.nuvolaris.io/macblock-original-replicas=<n>
```

L'enforcement deve essere idempotente. Eseguire due volte il blocco non deve
perdere lo snapshot originale delle repliche.

Il watchdog non deve scalare:

- risorse in `kube-system`;
- il proprio Deployment;
- componenti k3s core;
- namespace `ingress-nginx`, `velero`, `local-path-storage`;
- altri namespace applicativi, salvo requisito futuro esplicito.

Non sono previsti workload esclusi dentro `nuvolaris`: quando MacBlock entra in
stato bloccato, tutte le risorse target del namespace devono essere scalate o
sospese secondo le regole di enforcement.

## Recovery e ripristino

Il restore deve essere tracciabile. Il percorso normale e' l'auto-restore
quando il servizio seriali torna a rispondere `authorized=true` con lease
firmata valida; il comando manuale resta disponibile per recovery controllato.

Comando raccomandato:

```bash
ops bestia macblock restore --confirm RESTORE
```

Prerequisiti restore:

- il servizio seriali risponde `authorized: true`;
- la lease ricevuta e firmata e' valida;
- lo stato `blocked=true` esiste nel ConfigMap;
- lo snapshot delle repliche originali e' disponibile.

Azioni restore:

- ripristinare `Deployment`/`StatefulSet`/`ReplicaSet` alle repliche salvate;
- ripristinare `CronJob.spec.suspend`;
- ripristinare HPA neutralizzati/rimossi;
- rimuovere annotazioni `macblock` dove opportuno;
- impostare `blocked=false`;
- azzerare `consecutive_failures`;
- creare evento Kubernetes e log di audit locale.

Break-glass:

- deve esistere una procedura amministrativa documentata per emergenze offline;
- il break-glass deve richiedere accesso root o cluster-admin locale;
- deve essere rumoroso nei log;
- non deve essere il percorso normale dell'installer UI.

## Protezione da cancellazione

Obiettivo realistico: prevenire cancellazioni accidentali e rendere il
ripristino automatico. Nessuna protezione software nel cluster puo' fermare un
amministratore root determinato sul nodo.

Misure obbligatorie:

- installare il manifest come k3s AddOn in
  `/var/lib/rancher/k3s/server/manifests/bestia-macblock.yaml`;
- file manifest proprieta' `root:root`, permessi `0600` o `0640`;
- namespace `kube-system`;
- `priorityClassName: system-cluster-critical`;
- `restartPolicy: Always`;
- `PodDisruptionBudget`;
- RBAC minimo, senza usare `cluster-admin`;
- readiness/liveness probe;
- log chiari quando il componente viene ricreato dopo cancellazione.

Misure raccomandate:

- `ValidatingAdmissionPolicy` o webhook di admission che blocchi la delete di
  `Deployment/bestia-macblock`, ServiceAccount, RBAC e ConfigMap di stato,
  eccetto per un utente/gruppo break-glass documentato;
- etichette e annotazioni standard per riconoscere tutte le risorse MacBlock;
- monitoraggio con evento Kubernetes quando il pod viene ricreato;
- comando `ops bestia macblock doctor` che verifica presenza AddOn, Deployment,
  RBAC, Secret, ConfigMap, priority class, PDB e probe.

Finalizer:

- un finalizer puo' ridurre cancellazioni accidentali ma non deve essere la
  protezione principale;
- deve essere usato solo se il codice sa rimuoverlo in modo sicuro durante un
  uninstall autorizzato;
- un finalizer mal gestito puo' lasciare risorse bloccate in `Terminating`.

Static Pod:

- un vero static pod k3s aumenterebbe la resistenza a cancellazioni via API, ma
  complica l'uso di ServiceAccount/RBAC e tenderebbe a richiedere kubeconfig o
  privilegi host montati nel pod;
- per questa funzione e' preferibile un Deployment gestito da manifest AddOn
  k3s, per mantenere RBAC Kubernetes standard e privilegi minimi.

## RBAC minimo

Il ServiceAccount deve poter leggere il proprio stato e scalare solo il
namespace target.

Permessi indicativi:

- in `kube-system`:
  - get/list/watch/update/patch su `ConfigMap/bestia-macblock-state`;
  - get su `Secret/bestia-macblock-auth`;
  - create su `events`;
- in `nuvolaris`:
  - get/list/watch su `deployments`, `statefulsets`, `replicasets`,
    `cronjobs`, `jobs`, `pods`, `horizontalpodautoscalers`;
  - get/update/patch su subresource `scale` di Deployment/StatefulSet/
    ReplicaSet;
  - patch/update su `cronjobs`;
  - patch/update/delete/create su HPA solo se la strategia scelta li
    neutralizza/ripristina;
  - create su `events`.

Non deve avere:

- `cluster-admin`;
- permessi generici di delete su tutto il cluster;
- accesso a Secret di namespace applicativi non necessari;
- accesso a namespace diversi da `kube-system` e `nuvolaris`, salvo letture
  diagnostiche strettamente motivate.

## Sicurezza del pod

Requisiti container:

- filesystem root read-only dove possibile;
- drop di Linux capabilities non necessarie;
- `allowPrivilegeEscalation: false`;
- utente non-root quando compatibile con `nvidia-smi`;
- limiti CPU/memoria definiti;
- nessun hostPath generico, eccetto eventuali mount strettamente necessari al
  runtime NVIDIA;
- nessun `hostNetwork`, salvo prova tecnica che sia indispensabile;
- log senza seriali completi se il prodotto decide che il seriale e' dato
  sensibile; in questa specifica i seriali GPU non sono considerati dati
  sensibili e possono comparire nei log, mentre API key e payload sensibili no;
- TLS verification sempre attiva.

Network:

- egress consentito verso endpoint seriali Nuvolaris;
- accesso Kubernetes API interno necessario al ServiceAccount;
- se il CNI installato applica NetworkPolicy, definire una policy restrittiva;
- se k3s non applica NetworkPolicy nel profilo corrente, documentare che la
  restrizione e' best-effort.

## Comandi ops richiesti

Creare un gruppo futuro:

```text
ops bestia macblock
```

Comandi minimi:

```bash
ops bestia macblock install
ops bestia macblock uninstall --confirm UNINSTALL
ops bestia macblock status
ops bestia macblock doctor
ops bestia macblock verify
ops bestia macblock enforce --confirm BLOCK
ops bestia macblock restore --confirm RESTORE
ops bestia macblock logs
```

Semantica:

- `install`: crea/aggiorna manifest AddOn k3s, Secret/ConfigMap e RBAC;
- `uninstall`: rimuove il watchdog solo con conferma esplicita e senza
  ripristinare automaticamente `nuvolaris` se e' bloccato; funziona solo se
  viene inserita una chiave privata specifica conosciuta dal team Nuvolaris,
  conservata su 1Password e validata localmente tramite meccanismi
  crittografici, senza stampare la chiave nei log;
- `status`: mostra endpoint, ultimo successo, fallimenti consecutivi, lease,
  stato bloccato, risorse scalate e salute pod;
- `doctor`: valida installazione, RBAC, GPU discovery, accesso API, AddOn k3s e
  capacita' di enforcement dry-run;
- `verify`: esegue una verifica immediata senza cambiare stato, salvo
  aggiornare timestamp diagnostici;
- `enforce`: forza il blocco per test controllati;
- `restore`: ripristina risorse dal snapshot dopo autorizzazione valida;
- `logs`: mostra log watchdog e ultimi eventi Kubernetes correlati.

Se in futuro questi comandi modificano o creano `opsfile.yml`, usare la skill
`ops-task-authoring` prima di editare i file ops, come richiesto dalle regole
del repository.

## Struttura implementativa raccomandata

Percorso consigliato:

```text
macblock/                 # subrepo runtime image: nuvolaris/macblock
olaris-bestia/macblock/   # comandi ops di installazione/configurazione
```

File attesi:

```text
macblock/README.md
macblock/Containerfile
macblock/bestia-macblock.ts
macblock/spec.md
macblock/spec.svg
macblock/.github/workflows/publish.yml
olaris-bestia/macblock/README.md
olaris-bestia/macblock/docopts.md
olaris-bestia/macblock/opsfile.yml
olaris-bestia/macblock/bestia-macblock.ts
olaris-bestia/macblock/mock-api.ts
olaris-bestia/macblock/mock-api/spec.md
olaris-bestia/macblock/manifests/bestia-macblock.yaml
```

Prima di implementare MacBlock, creare `macblock/spec.svg` con il diagramma
della soluzione. Il diagramma deve mostrare almeno watchdog, namespace
`kube-system`, namespace `nuvolaris`, discovery GPU, endpoint esterno
`api.nuvolaris.io`, stato persistente, enforcement scale-to-zero e restore.
Durante lo sviluppo, ogni cambio architetturale o di flusso deve aggiornare
anche lo SVG nello stesso ciclo di modifica.

Come per gli altri moduli Bestia v2, `opsfile.yml` deve restare una superficie
sottile e delegare la logica a un runner Bun/TypeScript quando la logica diventa
non banale.

Il runner deve:

- generare manifest da valori configurati;
- referenziare l'immagine pullabile pubblicata dal subrepo root `macblock`;
- validare valori obbligatori prima di chiamare `kubectl`;
- usare `~/.ops/tmp/kubeconfig` o kubeconfig host coerente con gli altri task
  Bestia v2;
- evitare shell heredoc fragili quando produce YAML complesso;
- stampare errori azionabili.

L'immagine runtime del pod deve seguire `macblock/Containerfile`, essere
pubblicata su GHCR e includere almeno `bun`, `kubectl`, CA certificates/curl
support e `nvidia-smi`.

Il mock API di sviluppo deve essere documentato in
`olaris-bestia/macblock/mock-api/spec.md`. Deve esporre lo stesso endpoint
MacBlock-facing `POST /v1/serials_check`, supportare modalita' `allow`, `deny`,
`error`, `timeout` e `invalid-json`, ed essere eseguibile sia come server locale
sia come `Deployment/Service` Kubernetes in `kube-system` per prove end-to-end.
Il mock puo' usare HTTP e override di sviluppo espliciti; la produzione resta
vincolata a `https://api.nuvolaris.io/v1/serials_check`.

## Configurazione

Valori configurabili solo in sviluppo. In produzione questi valori sono fissati
dai default di release e non devono essere modificabili.

L'implementazione deve quindi ignorare override runtime per questi valori finche'
non viene abilitata esplicitamente una modalita' di sviluppo, ad esempio con
`BESTIA_MACBLOCK_DEV_OVERRIDES=true`.

```text
BESTIA_MACBLOCK_ENABLED=true
BESTIA_MACBLOCK_API_URL=https://api.nuvolaris.io/v1/serials_check
BESTIA_MACBLOCK_MAX_FAILURES=5
BESTIA_MACBLOCK_INTERVAL_SECONDS=60
BESTIA_MACBLOCK_TIMEOUT_SECONDS=10
BESTIA_MACBLOCK_NAMESPACE_TARGET=nuvolaris
BESTIA_MACBLOCK_NAMESPACE_SYSTEM=kube-system
BESTIA_MACBLOCK_AUTO_RESTORE=true
```

Regole:

- `MAX_FAILURES` default deve restare 5;
- `NAMESPACE_TARGET` default deve restare `nuvolaris`;
- `AUTO_RESTORE` default di prodotto: `true`;
- opzioni di sviluppo per simulare GPU o endpoint non devono essere abilitate
  nella release normale;
- config e secret devono essere esportabili/ripristinabili insieme al backup
  sistema Bestia v2.

## Osservabilita'

Il watchdog deve produrre:

- log strutturati con timestamp, esito verifica, classe errore e stato blocco;
- Kubernetes Events su successo dopo errore, soglia fallimenti raggiunta,
  enforcement avviato, enforcement completato, restore completato;
- output `status` leggibile da CLI;
- metriche opzionali Prometheus, se il runtime le supporta.

Metriche consigliate:

```text
bestia_macblock_authorized
bestia_macblock_consecutive_failures
bestia_macblock_blocked
bestia_macblock_last_success_timestamp
bestia_macblock_last_failure_timestamp
bestia_macblock_scaled_workloads_total
```

## Compatibilita' Bestia v2

Requisiti:

- runtime target: Ubuntu k3s Bestia v2;
- nessuna dipendenza Docker;
- usare host `kubectl` e kubeconfig coerente con gli altri task v2;
- non dipendere da `docker exec nuvolaris-control-plane`;
- non interferire con proxy `default-nginx`, Velero, local-path storage,
  Ollama k3s o componenti core k3s;
- non spegnere il watchdog quando si spegne `nuvolaris`.

L'enforcement su `nuvolaris` puo' rendere indisponibili system/console/app
tenant. I messaggi di stato devono quindi essere chiari e indicare che il blocco
e' intenzionale per licenza/sicurezza, non un guasto generico del cluster.

## Criteri di accettazione

Installazione:

- `ops bestia macblock install` crea il manifest AddOn k3s;
- il pod parte in `kube-system`;
- il pod usa `system-cluster-critical`;
- RBAC non usa `cluster-admin`;
- `doctor` conferma GPU discovery, RBAC e endpoint configurato.

Verifica autorizzata:

- con endpoint che risponde `authorized=true`, `nuvolaris` resta attivo;
- il contatore fallimenti viene azzerato;
- `status` mostra lease valida e ultimo successo.

Verifica negata:

- con endpoint che risponde `authorized=false`, il contatore incrementa;
- al quinto fallimento consecutivo viene impostato `blocked=true`;
- Deployment/StatefulSet/ReplicaSet target in `nuvolaris` vengono scalati a
  zero;
- CronJob target vengono sospesi;
- HPA target non riportano repliche sopra zero;
- lo snapshot delle repliche originali viene mantenuto.

Errore transitorio:

- timeout/DNS/TLS/5xx vengono registrati;
- se esiste una lease valida non scaduta, il blocco non parte immediatamente;
- se non esiste lease valida, dopo 5 fallimenti consecutivi parte il blocco.

Persistenza:

- riavviare o cancellare il pod non azzera il contatore;
- cancellare il Deployment lo fa ricreare dal manifest AddOn k3s;
- `status` dopo ricreazione legge lo stato persistente.

Restore:

- con autorizzazione valida, l'auto-restore ripristina repliche, CronJob e HPA
  salvati;
- con autorizzazione valida e conferma esplicita, `restore` manuale esegue lo
  stesso ripristino;
- il restore e' idempotente;
- il restore lascia eventi/log auditabili.

Sicurezza:

- API key non appare nei log;
- seriali GPU completi possono apparire nei log per diagnosi; API key e payload
  sensibili non devono apparire;
- TLS verification e' attiva;
- il pod non ha privilegi host non necessari.

## Test richiesti

Test unitari:

- parsing output `nvidia-smi`;
- classificazione risposte API;
- contatore fallimenti e lease;
- serializzazione/deserializzazione stato;
- generazione patch scale-to-zero;
- restore da snapshot.

Test di integrazione con cluster k3s:

- installazione AddOn;
- cancellazione pod e ricreazione automatica;
- verifica `authorized=true`;
- simulazione `authorized=false` per 5 tentativi;
- simulazione endpoint down senza lease;
- simulazione endpoint down con lease valida;
- HPA che prova a riscalare un Deployment bloccato;
- restore manuale;
- uninstall con conferma.

Test manuali/operativi:

- macchina con una GPU;
- macchina con piu' GPU;
- macchina senza GPU;
- GPU con seriale `N/A`;
- API key errata;
- endpoint TLS non valido;
- riavvio k3s durante stato bloccato.

## Domande aperte

- In installazioni multi-node future, il watchdog restera' singolo per
  appliance o diventera' un DaemonSet per nodo GPU? Da valutare.

## Implementation Requirements

- Creare e mantenere questa spec in `macblock/spec.md`.
- Creare `macblock/spec.svg` prima dell'implementazione e mantenerlo
  sincronizzato con ogni modifica architetturale o di flusso.
- Aggiornare `agent.md` con una voce concisa per ogni sessione di modifica.
- Prima di modificare o creare `opsfile.yml`/`opsfile.yaml`, usare la skill
  `ops-task-authoring`.
- Se l'implementazione insegna una regola operativa riusabile per
  Trustable/Nuvolaris, aggiornare sia `skills/trustable-project-ops/SKILL.md`
  sia la copia installata in `$CODEX_HOME/skills/trustable-project-ops/SKILL.md`.
