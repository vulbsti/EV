# The model atlas

What KenWise knows about models in general, before it knows anything about how they work for you. It ships with KenWise and is kept by the project's maintainers, from published research and from central test runs. Your own KenWise learns on top of it from your own work, and where the two disagree, your own evidence wins for you.

One file per model. The file says which catalogue models it covers (`models:`, written as they are named across providers: `claude-haiku-5-5` covers `claude-haiku-5.5` and `anthropic/claude-haiku-5.5` too). Each claim is one line, ending with how it is known:

```
- <what is true of the model, in plain words> [reported: <source>, <date>]
- <what is true of the model> [tested: <which run>, <date>]
```

- **reported**: published by the vendor or someone else, not checked here. A hint only.
- **tested**: a central test run agrees.
- **dropped**: a central test disagreed. Kept so it is not added again.
- **past**: was true of an earlier version, or the evidence turned.

Write claims about kinds of work (coding, writing, design, analysis, long documents, agentic tool use, speed, cost), not scores on their own. A claim KenWise cannot act on does not belong here. Price and context size come from the catalogue and are not repeated.
