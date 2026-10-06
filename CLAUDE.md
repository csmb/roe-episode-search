# Claude Instructions

## Timestamps

Always display timestamps for user messages and your own actions, as month, day and time only
(no weekday, year or time zone): run `date "+%b %-d %H:%M:%S"`.

- When the user gives a direction, run it and prefix your response with the timestamp, e.g. `[Feb 25 11:39:46] User:`
- When you take an action (start a job, report results, etc.), run it and prefix it with the timestamp, e.g. `[Feb 25 11:39:46] Claude:`
- Copy the time from that command's output, or from the "Current time:" line the project hooks add after each prompt and tool call; never estimate it.

## Project reference

@AGENTS.md
