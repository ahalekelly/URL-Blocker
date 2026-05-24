Work through this list one task at a time. Don't cut corners, complete all aspects of the task. Don't move on to the next tasks until you've fully completed every aspect of the task and then tested the app rigorously, including with Computer Use in Safari and Brave. Especially test for anything that is new or could have been affected by the change. When you finish the task, run make install, move the task to Done with a short description of your changes with any issues you ran into or extra changes you made, and then commit. Include TODO.md in your commits.

Done, ready for review:
Make better integration and end-to-end tests and use them to find bugs in the existing code.
Remove the existing save button, make the Save button float in the bottom right of the screen when there are unsaved changes
Make the title of each block group larger, and make the URLs not bold.
Make a file with a list of suggested UI improvements - Added suggested-ui-improvements.md with 10 prioritized options-page improvements from live Safari/Brave review. Note: AGENTS.md references ios_safari_site_blocker_spec.md, but that file is not present in this checkout.

To Do:
Make a new page with comprehensive screen time statistics
The shared code is in the URLBlockerIOSExtension folder, update the folder names so that they reflect their contents and update any required code
Make the displayed times round to the nearest minute
The sign in buttons are still shown after we're signed in, on both Vivaldi and iOS. And on iOS there's a floating header on the bottom so you don't need the sign in buttons at all
