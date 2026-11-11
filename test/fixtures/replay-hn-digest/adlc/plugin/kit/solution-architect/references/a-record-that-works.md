---
record: architecture-record-v1
statement: "An agent that reads the customer list and emails each customer a short reminder before their renewal. It may spend at most 5 USD a day."
environments: [dev, test, production]
kind: plugin-on-harness
done: yes
questions: 0
systems: [database, mail, text-reasoning]
standing_assets: [https://schemas.agentmesh.ai/brand/v1, https://schemas.agentmesh.ai/style-guide/v1]
cost_limit: "at most 5 USD a day"
bindings:
  database:
    dev: supabase (customer)
    test: supabase (customer)
    production: supabase (customer)
  mail:
    dev: resend (customer)
    test: resend (customer)
    production: resend (customer)
  text-reasoning:
    dev: platform (platform)
    test: platform (platform)
    production: platform (platform)
---

# Architecture record: renewal reminders by email

This record is finished: every system is named and bound in each environment, and every decision has its reason.

## Statement

> An agent that reads the customer list and emails each customer a short reminder before their renewal. It may spend at most 5 USD a day.

## Systems

- `database` (the customer list), read: The customers and their renewal dates are kept there.
- `mail` (a mail sender), write: Each reminder goes to a customer by email.
- `text-reasoning` (text reasoning), trigger, for text: a short, plain reminder in the customer's own terms: Writing each reminder so it reads as a person wrote it is a judgment.

## Bindings

| System | dev | test | production |
|---|---|---|---|
| database | supabase, the organization's choice | supabase, the organization's choice | supabase, the organization's choice |
| mail | resend, the organization's choice | resend, the organization's choice | resend, the organization's choice |
| text-reasoning | platform (AgentMesh's models), platform default | platform (AgentMesh's models), platform default | platform (AgentMesh's models), platform default |

## Dependencies

None.

## Kind

**plugin-on-harness**: A short program with one judgment: read, write each reminder, send. A harness reading skills carries it.

## Components

- **the harness** (`harness`), the harness: Starts the skill's script once per job, hands it the job's input and settings, and sends back what it writes as the reply.
  - **renewal-reminders** (`skill-renewal-reminders`), a skill: Emails each customer whose renewal is due a short reminder, and reports the run.
    - **scripts/renewal-reminders.mjs** (`script-renewal-reminders`), a script: Reads the due customers, has each reminder written, sends it, and writes the run's account.
      - **customer reader** (`customer-reader`), a part: Reads the names, emails and renewal dates of the customers whose renewal is due. It reaches `database`.
      - **reminder writer** (`reminder-writer`), a part: Has the model write each reminder in the customer's own terms, through the shared model caller. It reaches `text-reasoning`.
      - **mail sender** (`mail-sender`), a part: Sends each reminder to its customer and notes what went out. It reaches `mail`.
      - **account writer** (`account-writer`), a part: Writes the run's account under Sent and Skipped.
- **the customer list** (`database`), an outside system: The customers and their renewal dates are kept there.
- **a mail sender** (`mail`), an outside system: Each reminder goes to a customer by email.
- **text reasoning** (`text-reasoning`), an outside system: The model behind the shared caller, for text: a short, plain reminder in the customer's own terms.

## Connectors

- `caller` to `harness`: a job message, which the host hands to the harness; it carries which customers to remind.
- `harness` to `script-renewal-reminders`: by command: node scripts/renewal-reminders.mjs, started once per job, with the job's input and the setting days-before as flags (the job's run, Common Agent Section 12.3); it carries which customers to remind and days-before.
- `customer-reader` to `database`, read: through the product bound to it in each environment, with the credential and address the install places (Common Agent Section 12.4); it carries names, emails and renewal dates.
- `mail-sender` to `mail`, write: through the product bound to it in each environment, with the credential and address the install places (Common Agent Section 12.4); it carries each reminder.
- `reminder-writer` to `text-reasoning`, trigger: through the shared model caller (scripts/model-caller.mjs) and its four settings, MODEL_NAME, MODEL_ENDPOINT, MODEL_KEY and MODEL_PROTOCOL, read on every call (Common Agent Section 12.4.1); it carries each customer's name and renewal date.
- `script-renewal-reminders` to `caller`: written to the script's standard output, which the harness hands back as the job's reply; it carries the run's account (`text/markdown`).

## Runtime and deployment

Runs once per job: the harness starts the skill's script as a command, and the process ends when the reply is written. It has no service of its own, opens no port and keeps no process between jobs.

- dev: `database` on supabase, the organization's choice; `mail` on resend, the organization's choice; `text-reasoning` on platform (AgentMesh's models), a platform default.
- test: `database` on supabase, the organization's choice; `mail` on resend, the organization's choice; `text-reasoning` on platform (AgentMesh's models), a platform default.
- production: `database` on supabase, the organization's choice; `mail` on resend, the organization's choice; `text-reasoning` on platform (AgentMesh's models), a platform default.

## Data flow

1. `caller` to `harness`, which customers to remind: The owner says which renewals are due.
2. `harness` to `script-renewal-reminders`, which customers to remind and days-before: The harness starts the script with the job and the setting as flags.
3. `database` to `customer-reader`, names, emails and renewal dates: The reader reads the due customers.
4. `reminder-writer` to `text-reasoning`, each customer's name and renewal date: The writer asks the model for one short reminder.
5. `mail-sender` to `mail`, each reminder: The sender mails each reminder to its customer.
6. `account-writer` to `caller`, the run's account: The account goes back as the reply, through the harness.

## Drivers

- **Cost** (`cost`): at most 5 USD a day. The statement says so. Cited by decision 1.
- **Speed** (`speed`): a whole list sent within 600 seconds. A list of a few hundred customers is one pass. Cited by decision 1.
- **Data** (`data`): reads names, emails and renewal dates; keeps nothing between runs; never sends the list anywhere but the mail sender. Customer data stays in the organization's own database.
- **Trust** (`trust`): takes the run only from its owner. Sending email to customers is the organization's voice. Cited by decision 2.

## Egress

- dev: the target runs the agent open (it enforces no allowlist today).
- test: the target runs the agent open (it enforces no allowlist today).
- production: the target runs the agent open (it enforces no allowlist today).
- None beyond the derived set (its systems, the network, the registrar, the model it is given).

## Formats

- It hands back the run's account as `text/markdown`; a header `sent, skipped`, then `## Sent` and `## Skipped` with one bullet per customer and why. A person reads what went out.
- It takes which customers to remind as `text`, given by a person. The owner says which renewals are due, in words.

## Standing assets

- **the run's account** (`text/markdown`, written copy): the style guide (`https://schemas.agentmesh.ai/style-guide/v1`), because written copy a person reads speaks for the organization, and the style guide says its voice, its spelling and the words it uses and avoids; the brand profile (`https://schemas.agentmesh.ai/brand/v1`), because written copy that speaks for the organization names it, and the brand profile says how its name is written, how it is first mentioned and the words it never says.
- The Design declares exactly these as `can_use`, each with what it reads, what it does with it and what it does `without` it: `https://schemas.agentmesh.ai/brand/v1`, `https://schemas.agentmesh.ai/style-guide/v1`.

## Settings

- `days-before` ("Days before renewal"), a preference with the default 14, from 1 to 60 in steps of 1: How many days before a renewal the reminder goes. How far ahead of a renewal a reminder goes is the organization's habit; two weeks is common.

## Decisions

Decisions 1 and 2 choose the agent's structure. Decisions 3 to 5 are rulings: the standard's rules applied, and the answers a person or the build gave.

### Decision 1. Code walks the list, and the model writes only each reminder

Context: Every run is the same: read the due customers, write each reminder, send it.

Drivers: `cost` (at most 5 USD a day); `speed` (a whole list sent within 600 seconds).

Why: One model call per customer bounds the spend and lets each step be tested.

Alternatives:

- A model that reads the list and decides whom to email: not chosen, because what it sends and spends would not be bounded.

Consequences:

- The job is control script, intelligence called and contract full.

### Decision 2. Report each run as Markdown

Context: A person reads what went out.

Drivers: `trust` (takes the run only from its owner).

Why: A person reads it.

Alternatives:

- a vendor JSON kind: not chosen, because only code reads it.

Consequences:

- Its headings are fixed so a test can hold them.

### Decision 3. Bind database to supabase in dev, and supabase in test and production

Why: The person named supabase for dev in an answer. The organization chose supabase for test and production (the organization's stack, bound since 2026-10-20).

Weighed: Another product behind database: Supabase and Firestore, which the organization can choose on its stack.

What follows: The install places the credential and address this binding names; the package names neither.

### Decision 4. Bind mail to resend in dev, test and production

Why: The organization chose resend for dev, test and production (the organization's stack, bound since 2026-10-20).

Weighed: Another product behind mail: Resend and Amazon SES, which the organization can choose on its stack.

What follows: The install places the credential and address this binding names; the package names neither.

### Decision 5. Bind text-reasoning to platform (AgentMesh's models) in dev, test and production

Why: The organization chose no product for text-reasoning, so the House Stack's product fills each as a platform default: AgentMesh chooses the model and keeps it current. Every harness AgentMesh deploys uses it unless its owner names another model, and the key sits on the machine that deploys it.

Weighed: Another product behind text-reasoning: a model provider of the organization's own, bound on its stack with its own key.

What follows: The install places the model from this binding in the four settings MODEL_NAME, MODEL_ENDPOINT, MODEL_KEY and MODEL_PROTOCOL, and the scripts read them on every call through the shared model caller and name no model, so changing the model is a setting and not a rebuild.

## Questions

None. Every system is named and bound in each environment, and every decision has its reason.
