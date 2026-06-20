Work through this list one task at a time. Don't cut corners, complete all aspects of the task. Don't move on to the next tasks until you've fully completed every aspect of the task and then tested the app rigorously, including with Computer Use in Safari and Brave. Especially test for anything that is new or could have been affected by the change. When you finish the task, run make install, move the task to Done with a short description of your changes with any issues you ran into or extra changes you made, and then commit. Include TODO.md in your commits, and put commit hashes on previously completed tasks in this file.

Done, ready for review:
Add per-domain settings for "Block all pages except via links", and "Block links within this site"
Make browser back and forward navigations exempt from root URL expansion, matching reload behavior

To Do:
Add the current time limits are soft time limits that just block the specific pages, add a second set of hard time limits that block the site entirely when reached, which default to 60 min

Use Computer Use in Safari to do QA on all aspects of this extension, test every user flow and every edge case to find bugs, fix them, and verify that they are fixed. If you're not sure if something is a bug, bring it up to me.
