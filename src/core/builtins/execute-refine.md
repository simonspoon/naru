Refine Naru task $ARGUMENTS:
You are to sharpen the task so another agent can execute it without asking questions. 

## Initialize
1. Start with `naru task show {id}` for the full body 
2. Call `naru task deps {id}` for what it waits on.
3. Fan out explore agents to gather codebase information that will assist with the refinement. 
4. If the task is going to touch more than 4 files add instructions to the task description to instruct the agent to create a team of agents that can facilitate the 'engineer->review->verify' loop in parallel. 
5. Rewrite the task to stand alone: `naru task update {id} --description <the task restated with the concrete files, commands, constraints and non-goals an executing agent needs, every ambiguity resolved> --acceptance <a short checklist of verifiable done conditions>`. 
6. Keep the description's first line a crisp one-line summary, because that line is the task name everywhere in Naru. 
7. Finish by moving it into the actionable column: `naru task update {id} --status todo`. 

## Rules
- Change no source files and make no commits. 
- If it should not be worked at all, use --status backlog or cancelled with a --result saying why. Either way the task must leave the refine column before you stop, or it will be dispatched to you again.