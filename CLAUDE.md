# Claude Instructions

## Timestamps

Always display timestamps for user messages and your own actions.

- When the user gives a direction, run `date` and prefix your response with the timestamp, e.g. `[Wed Feb 25 11:39:46 PST 2026] User:`
- When you take an action (start a job, report results, etc.), run `date` and prefix it with the timestamp, e.g. `[Wed Feb 25 11:39:46 PST 2026] Claude:`
