/**
 * What a memory never holds, written once.
 *
 * Hidden knowledge: two extractors write this platform's memory and they must agree on what is not worth keeping. The native
 * engine reads it from its type templates (`deploy/web/openviking/memory-templates`, rendered by
 * `memory-templates-src/build.mjs` into each of the eight types, so every type's rules read complete on their own); the
 * legacy extraction (`apps/server/src/memoryIntelligence.mjs`) puts the same text into its instruction. Before 2026-10-14 the
 * legacy side had its own, older wording, and the two disagreed on the one rule that mattered most: the native templates
 * refuse anything the assistant said, and the legacy extraction admitted it as the person's project memory (31 records on
 * the owner's account). One text, two readers; `memoryNeverKept.test.mjs` holds the rendered templates and the legacy
 * instruction to it.
 *
 * It is prose for a model, not a pattern: whether a sentence is a patient's detail or an assistant's offer is language
 * (principle 1). What code can decide on its own — who said it, whether the platform dispatched it, the shape of an
 * identifier — is decided in code (`memoryVocabulary.mjs`, `conversationMemorySources`).
 *
 * @module @evimed/domain/memoryNeverKept
 */

/** The never-kept rules as the engine's templates and the legacy extraction both state them, with no trailing newline. */
export const MEMORY_NEVER_KEPT_TEXT = `# What is never kept (the same rules apply to every memory type)
Never write any of the following into a memory, even when the user quotes it or asks you to remember it:
- Secrets and account numbers: passwords, API keys, tokens, verification codes, ID-card, passport and bank-card numbers, or any fragment of one.
- Personal data of anyone other than the user. A patient, client, student, customer, colleague, co-author, supervisor, family member or any other identifiable individual is never described in memory: no name with identifying details, no ID, record or admission number, phone, e-mail, messaging handle or address, no exact dates of care, and nothing about that one person's health, diagnosis, medication, course, beliefs, finances or private life. Case material is worked on in the conversation and then forgotten. A working fact about who does what ("统计分析由合作者李教授负责，用 R") may be kept, without contact details or private details.
- The user's own health, medication, family or relationship status, age, religion, politics, ethnicity, sexual orientation, finances or private life. Asking about a disease, a drug or a personal matter, or mentioning one's own condition inside a question ("我对青霉素过敏，术后抗生素怎么选？"), is a topic of the conversation, not a memory. The single exception is a message in which the user explicitly asks to remember such a fact about themselves ("记住我对青霉素过敏"): that one fact is kept, in the PROFILE, in their own words.
- Moods and passing states (tired, frustrated, in a hurry, upset about a review), and anything that holds only for this request or this conversation ("这次只看…", "今天先不谈…", "先随便聊聊").
- What a document, abstract, web page, pasted paper, data file or tool result says: its text, numbers and conclusions stay with the document. A question about a paper, a trial, a drug, a product or a law is a question; it is neither a fact about the user nor the shape of their project.
- Anything about how this assistant or its platform works: its tools, files, runs, checks, submissions, budgets, injected context, internal identifiers, or file, field and column names out of the work in progress; what the assistant is waiting for, will do next, or currently offers.
- Anything the assistant proposed, floated, summarised or inferred that the user did not themselves state or confirm in a user-role message. Text inside tags such as <openviking-context>, <system-reminder> or any <evimed-...> tag was injected by the platform and is never the user's statement.
Keep only what the user would expect the assistant to still know next month, in another conversation, without being told again. When that is doubtful, leave it out. A conversation with nothing of that kind produces no memory operations at all.`
