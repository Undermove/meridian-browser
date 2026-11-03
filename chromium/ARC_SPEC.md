# Arc's behaviour, from its help center

What Meridian has to match, one checkable sentence per item, with the source. Collected on
04.11.2026 from resources.arc.net (feature articles via the Wayback Machine, since Arc is sunset).
Each item becomes an E2E test (see CLAUDE.md); the test name says which item it covers.

Help center caveat: Arc is being sunset, and the live help center (resources.arc.net) now has only 22 articles, mostly release notes and sunset FAQs. Every feature article (Pinned Tabs, Peek, Split View, Little Arc, Keyboard Shortcuts and the rest) has been taken down. I read those from Wayback Machine snapshots (2023–2026 captures) of the original URLs. The release notes came from the live help center API. arc.net/shortcuts returns 404 and now redirects to an "A farewell to Arc" page. The [Sxx] codes after each item are listed with their full URLs at the end.

SIDEBAR: PINNED TABS
1. When a tab is focused and the user presses ⌘D, Arc pins it into the current Space's Pinned section; pressing ⌘D on a pinned tab unpins it. [S-PIN] [S-KB]
2. When a tab is dragged above the horizontal divider line in the sidebar, Arc moves it into the Pinned section; dragging it below the line moves it to the Unpinned section. [S-PIN]
3. When the user types "Pin Tab" (or "Unpin") in the ⌘T command bar, Arc pins (or unpins) the current tab. [S-PIN]
4. When Arc pins a tab, it belongs only to the current Space and is not shown in other Spaces. [S-PIN]
5. When pinned tabs are left idle for any length of time, Arc never auto-archives them. [S-PIN]
6. When the user clicks a link inside a pinned tab that would take the tab to a different site, Arc opens the link in a Peek window and the pinned tab stays on its site. Links within the same site navigate in place. [S-PIN]
7. When a pinned tab has navigated away from its pinned URL, Arc shows a slash (/) next to the tab's name in the sidebar. [S-SLASH]
8. When the user clicks the favicon of a pinned tab that has navigated away, Arc resets the tab to its original pinned URL. [S-SLASH] [S-PIN] [S-RN21]
9. When the user types "Reset Tab" in the ⌘T command bar on a pinned tab, Arc resets it to its pinned URL. [S-PIN]
10. When the user ⌘-clicks the icon of a pinned tab that has navigated away, Arc resets the pinned tab to its original URL and opens the URL it was on in a new tab. [S-RN24]
11. When the user right-clicks a pinned tab or favorite and chooses "Edit Pinned Page" > "Replace Pinned URL with Current", Arc makes the current URL the new pinned URL. [S-REVERT]
12. When the user right-clicks a pinned tab or favorite and chooses "Edit Pinned Page" > "Edit…", Arc lets the user type a new pinned URL by hand. [S-REVERT]
13. When the user right-clicks a tab and selects "Duplicate", or holds ⌥ while dragging a tab in the sidebar, Arc creates a duplicate of that tab. [S-PIN]
14. When a tab is duplicated through right-click > Duplicate, Arc also copies its back/forward history. [S-RN23]
15. When the user clicks the caret (>) next to the Space title, Arc collapses the Pinned section, and clicking it again expands it. [S-PIN]
16. When the user types "Collapse Pinned" or "Expand Pinned" in ⌘T, Arc collapses or expands the Pinned section. [S-RN24]
17. When the Pinned section is collapsed and the user moves through sidebar tabs with the keyboard, Arc skips the pinned tabs. [S-RN24]
18. When a pinned URL redirects, Arc shows the tab with the title of the page it lands on. [S-RN23]

SIDEBAR: UNPINNED / TODAY, CLEAR, ARCHIVE
19. When the user presses ⇧⌘K (or clicks "Clear" above the Unpinned tabs), Arc clears every unpinned tab in the current Space. [S-KB] [S-RN23]
20. When the user right-clicks a tab and chooses "Archive Below", Arc archives every tab below it. Split View tabs support this too. [S-RN22] [S-RN23]
21. When an unpinned tab has been idle longer than the profile's "Archive tabs after" setting (12 hours by default), Arc moves it to the Archive. [S-ARCH] [S-RN21]
22. When the user views or clicks an unpinned tab, Arc restarts its auto-archive timer. [S-ARCH]
23. When a tab is playing media, Arc does not auto-archive or clear it. [S-RN22]
24. When a tab is inside a folder, Arc never auto-archives it. [S-FOLD]
25. When the user looks for a way to turn auto-archive off, Arc offers none. [S-ARCH]
26. When different profiles have different values in Settings > Profiles > "Archive tabs after", Arc archives each profile's Spaces on that profile's schedule. New profiles inherit the Default profile's timing. [S-ARCH] [S-RN24]
27. When the user types "View Archive" in ⌘T, Arc opens the archive, which lists both closed and auto-archived tabs from every Space. [S-ARCH] [S-LIB]
28. When the user clicks the Restore icon next to an archived tab, Arc restores the tab into the Space it came from. If an Air Traffic Control route matches the tab, Arc follows the route instead. [S-ARCH] [S-RN23]
29. When the user types "clear archive" in ⌘T and presses Return, or right-clicks Archived Tabs in the Library and chooses "Clear Archive", Arc deletes every archived tab. Archive > Clear Archive in the menu bar does the same after a confirmation dialog. [S-ARCH] [S-RN23]
30. When a download finishes, Arc auto-archives the download the same way it archives tabs. [S-RN22]
31. When the user presses ⌘Z after moving tabs in the sidebar or clearing the unpinned section, Arc undoes that action. [S-RN21]
32. When several tabs are selected with ⌘-click and the user presses ⌘W, Arc closes all of them. [S-RN22]
33. When a tab is dragged out of the sidebar, Arc opens it in a new Blank Window. [S-WIN]
34. When a new tab is created in a Space, Arc shows that tab in the same Space in every Arc window. [S-WIN]
35. When the user types "new blank window" in ⌘T, Arc opens a fully separate window whose tabs are not shared with other windows. [S-WIN]
36. When the user picks a backup under Help > Restore Data in the menu bar, Arc restores the sidebar to that state. Arc keeps 10 backups for the current day, 1 per day for 10 days, 1 per week for the prior month, and 1 per month for the prior year. [S-RESTORE]
37. When Arc is restarted, it restores the previous browsing state without the user reopening tabs. [S-RN24]

SIDEBAR: FOLDERS
38. When the user clicks + at the bottom of the sidebar, Arc offers to create a new folder. Rename, Move and Delete are available by right-clicking the folder title. [S-FOLD]
39. When a tab is dropped onto a folder, or the user picks right-click > "Move To" > the folder, Arc moves the tab into that folder. [S-FOLD]
40. When the user hovers over a closed folder's title and picks a tab from the preview list, Arc shows that tab peeking out under the still-closed folder instead of opening the whole folder. [S-FOLD]
41. When a tab is moved into a folder, Arc shows it peeking out of the folder so the user keeps their place. [S-RN23]
42. When several tabs are ⌘-click selected and the user chooses right-click > New Folder (or ⌘T "New Folder"), Arc pins them all into a new folder. [S-RN22]

SIDEBAR: FAVORITES
43. When a tab is dragged above the Space title to the very top of the sidebar, or the user picks right-click > Move To > Favorites (or ⌘T "Move To Favorite Tab"), Arc makes it a favorite. Its icon then appears in the top row in every Space. [S-FAV]
44. When a favorite is dragged below the Space title, or moved with Move To > [sidebar section], Arc removes it from Favorites and puts it in that section. [S-FAV]
45. When the user tries to add a 13th favorite in one profile, Arc refuses because the limit is 12. [S-FAV] [S-RN23]
46. When the user clicks a favorite that has navigated away, Arc returns it to its favorited URL, the same way pinned tabs reset. [S-REVERT]
47. When the user clicks a link in a favorite that leads to another site, Arc opens it in Peek. [S-PEEK]

SIDEBAR: VISIBILITY AND LAYOUT
48. When the user presses ⌘S, Arc hides the sidebar, and pressing ⌘S again shows it. [S-HIDE] [S-KB]
49. When the user drags the sidebar's edge, Arc resizes the sidebar, and double-clicking the edge restores the default width. [S-RN21]
50. When the user presses ⌘. (period), Arc moves focus to the sidebar so the arrow keys move between items. [S-RN21]
51. When the user presses ⇧⌘D, Arc toggles the toolbar with the URL bar above the page. [S-URL]
52. When the Arc window loses focus, Arc dims the sidebar slightly. [S-RN23]

SPACES
53. When the user clicks + at the bottom of the sidebar, Arc offers to create a new Space. Each Space has its own Pinned section, Unpinned section, theme and icon. [S-SPC]
54. When the user clicks a Space's icon at the bottom of the sidebar, Arc switches to that Space. [S-SPC]
55. When the user swipes left or right with two fingers on the trackpad over the sidebar, Arc switches to the neighbouring Space. [S-SPC]
56. When the user presses ⌃1, ⌃2, ⌃3 and so on, Arc switches to Space 1, 2, 3 and so on. [S-SPC] [S-KB]
57. When the user presses ⌘⌥← or ⌘⌥→, Arc switches to the previous or next Space. [S-KB]
58. When the user types a Space's name in ⌘T, Arc offers to switch to that Space. [S-SPC]
59. When the user types "Move to [Space]" in ⌘T, Arc moves the current tab to that Space. [S-RN23]
60. When a tab is dragged left or right onto another Space, Arc moves the tab into that Space. [S-RN22]
61. When the user presses mouse buttons 3 or 4, Arc cycles between Spaces. [S-RN22]
62. When the user hovers over the Space title, clicks Edit/… and picks "Theme" (or right-clicks empty sidebar space and picks "Theme"), Arc opens the Theme Picker for that Space. [S-SPC]
63. When the user picks sun, moon or stars at the top of the Theme Picker, Arc switches every Space to Light, Dark or Automatic (follows macOS) mode. [S-SPC]
64. When the user clicks the (−) button in the Theme Picker, Arc removes all colours and goes back to the default theme. [S-THEME]
65. When the user types "Manage Spaces" in ⌘T, Arc opens the Space Manager, where all Spaces can be edited and reordered. [S-RN22]

PROFILES
66. When the user hovers over the Space title, clicks … > Profile and picks or creates a profile, Arc assigns that profile to the Space. [S-PROF]
67. When a Space uses a profile, Arc keeps logins, passwords, autofill, history, cache, cookies, favorites, extensions, archive settings and arc://settings values (such as language and download location) separate per profile. [S-PROF]
68. When a new profile is created, Arc starts it with no logins and no history. [S-PROF]
69. When the user picks Edit > Profile > Default on a Space, Arc removes the custom profile from that Space. [S-PROF]
70. When a profile is still assigned to any Space, Arc disables its "Delete Profile" button in Settings > Profiles. [S-PROF]
71. When the user switches Spaces while the command bar is open, Arc refreshes the suggestions for the new Space. When the target Space uses a different profile, Arc resets them so the previous profile's suggestions are not shown. [S-RN24]

COMMAND BAR
72. When the user presses ⌘T, Arc opens the centred command bar for searching or typing a URL. [S-KB] [S-RN21]
73. When the command bar is already open and the user presses ⌘T or ⌘L again, Arc closes it. [S-RN23]
74. When the user presses ⌘L, Arc opens the command bar prefilled to edit the current tab's URL. [S-KB]
75. When the user presses ⌘L and then Return without changing anything, Arc reloads the current page. [S-RN23] [S-RN24]
76. When the user types in ⌘T, Arc suggests URLs from browsing history, open tabs (switching to a tab in another Space is marked as such), Spaces, folders ("Open [Folder Name]") and actions (Pin, Split, Archive, Settings and so on). [S-CBX] [S-SPC] [S-RN22]
77. When the user types "/ " in ⌘T, Arc shows only Arc actions, and pressing Tab right after opening ⌘T also lists the actions. [S-RN22] [S-RN24]
78. When the user hovers over a history suggestion and clicks its X, or selects it and presses ⌘⌥⌫, Arc deletes that suggestion. Default suggestions cannot be deleted. [S-CBX] [S-RN23]
79. When the clipboard holds a URL and the user opens ⌘T, Arc shows "Paste and Go" as a top option. [S-RN23]
80. When the user presses ⌘⌥V, Arc opens the clipboard URL as a new tab. [S-RN23]
81. When the user types a site-search keyword in ⌘T (for example "yt"), presses Tab, types a query and presses Return, Arc searches that site. [S-SITE]
82. When the user copies an address from the command bar, Arc adds https:// to it automatically. [S-RN22]
83. When the sidebar is clicked while ⌘T is open, Arc handles the click without the command bar having to be closed first. [S-RN24]

TAB SHORTCUTS
84. When the user presses ⌘W, Arc closes the current tab or window. [S-KB]
85. When the user presses ⇧⌘T, Arc reopens the last closed tab with its full history. If the last closed item was a Peek, Arc reopens the Peek. ⌘Z does the same. [S-KB] [S-RN21] [S-RN23]
86. When the user presses ⇧⌘C, Arc copies the current tab's URL with tracking parameters removed. [S-KB] [S-RN21]
87. When several tabs are selected and the user presses ⇧⌘C, Arc copies all of their URLs. [S-RN22]
88. When the user presses ⇧⌥⌘C, Arc copies the current tab's URL as Markdown. [S-KB]
89. When the user presses ⌘1 through ⌘8, Arc goes to that sidebar item. A setting decides whether favorites are counted, and another decides whether ⌘9 opens the 9th tab or the last one. [S-KB] [S-RN22]
90. When the user presses ⌘⌥↑ or ⌘⌥↓, Arc moves to the previous or next tab in sidebar order. [S-SWITCH] [S-KB]
91. When the user presses ⌃Tab, Arc opens the switcher for the five most recent tabs. Holding ⌃ and pressing Tab again moves forward, ⌃⇧Tab or ⌃` moves back, and tapping W while ⌃ is held closes the highlighted tab. [S-SWITCH] [S-RN23]
92. When the user presses ⌘[ or ⌘←, Arc goes back in tab history, and ⌘] or ⌘→ goes forward. [S-KB]
93. When the user ⌘-clicks the back/forward buttons or middle-clicks them, Arc opens that history entry in a new tab. [S-RN23]
94. When the user ⌘-clicks the reload button, Arc duplicates the current tab. [S-RN23]
95. When the user presses ⌘N, Arc opens a new window. ⌃⌘N opens a blank window, and ⇧⌘N opens an incognito window. [S-KB] [S-RN23]
96. When Arc is full screen and the user presses ⌘N, Arc opens the new window in full screen. [S-RN23]
97. When the user presses ⌘Y, Arc shows history, which is also under Archive > View History. [S-HIST] [S-KB]
98. When the user presses ⌘R, Arc reloads the page, and ⇧⌘R hard-reloads it. [S-KB] [S-RN21]
99. When a web page and Arc use the same shortcut, Arc lets the page handle the first press and runs Arc's own shortcut on a second press. [S-RN21]

PEEK
100. When the user clicks a link to another site from a pinned tab or a favorite, Arc opens it in a Peek overlay instead of a new tab. [S-PEEK] [S-RN23]
101. When the user ⇧-clicks any link, Arc opens it in Peek. This can be turned off in Settings > Links. [S-RN23]
102. When a Peek is open and the user presses ⌘O or clicks the expand arrows, Arc turns the Peek into a full tab. [S-PEEK]
103. When a Peek is open and the user clicks the Split View button, Arc turns it into a Split View. [S-PEEK] [S-RN24]
104. When a Peek is open and the user clicks outside it, clicks its X or presses ⌘W, Arc closes the Peek. [S-PEEK]
105. When "Open the Peek window when you click links to other sites" is unchecked in Settings, Arc opens those links in new tabs. [S-PEEK]
106. When a link opened in Peek matches an Air Traffic Control route, Arc opens it according to that route. [S-RN24]
107. When the user clicks a meeting link, Arc opens it in a new tab, not in Peek. [S-RN23]

SPLIT VIEW
108. When a sidebar tab is dropped in the middle of the page, or onto another sidebar tab, Arc creates a Split View that shows up as a single tab in the sidebar. Dropping on the left or right side of the target sets the panel order. [S-SPLIT] [S-RN24]
109. When the user presses ⌃⇧+ or types "Add Right/Left/Top/Bottom Split" in ⌘T, Arc adds a split panel on that side. [S-SPLIT] [S-KB] [S-RN23]
110. When the user presses ⌃⇧−, Arc closes the split panel. [S-KB]
111. When the user presses ⌃⇧1, ⌃⇧2 and so on, Arc moves focus to that split panel. [S-KB]
112. When the user picks "Separate All Tabs" on a split tab, clicks X above a panel, or clicks X next to a split tab in the sidebar, Arc leaves Split View. [S-SPLIT]
113. When the user ⌥-clicks a split tab in the sidebar, Arc separates it into its own tabs. [S-RN23]
114. When the user ⌥-clicks a link or tab, Arc opens it in Split View. ⌥-clicking the current tab duplicates it into a split. [S-RN21] [S-RN23]
115. When a split panel is focused and the user presses ⌘L, Arc edits that panel's URL only. [S-SPLIT]
116. When a tab is dragged onto a tab in the Pinned section to create a split, Arc keeps the split in the Pinned section. [S-RN24]
117. When the user uses the Split Controls button, Arc switches the split between side-by-side and top-to-bottom. [S-RN23]
118. When a split is pinned, favorited, renamed or moved, Arc treats it as one unit. [S-RN22]

LITTLE ARC
119. When a link is clicked in another macOS app such as Slack or iMessage, Arc opens it in a separate Little Arc window by default. [S-LA] [S-ATC]
120. When the user presses ⌘⌥N from anywhere, Arc opens a new Little Arc window for searching. [S-LA] [S-KB]
121. When the user ⌘⌥-clicks a sidebar tab, Arc opens it in a Little Arc window. [S-LA] [S-RN22]
122. When Little Arc is focused and the user presses ⌘O (or clicks "Open In"), Arc moves the link into the main window's most recent Space. ⌘⌥O lets the user pick another Space. [S-LA] [S-RN21]
123. When Little Arc is focused and the user presses ⌘W, Arc closes it, and the link goes to the Archive (filter "Little Arc"). [S-RN24]
124. When a Little Arc window is left open longer than its auto-archive time (6 hours by default), Arc archives it. [S-LA]
125. When the same link is clicked again in an external app, Arc brings back the existing Little Arc window instead of opening a duplicate. [S-RN23]
126. When the user picks a profile in Little Arc for a domain, Arc pre-selects that profile for future links from that domain. [S-RN23]
127. When Arc is full screen and an external link is clicked, Arc shows Little Arc above the full-screen window. [S-RN23]
128. When Little Arc is turned off in Settings, Arc opens external links in the sidebar. [S-LA]

AIR TRAFFIC CONTROL
129. When a link from any source matches a route of type "URL contains <text>", Arc opens it in that route's Space. [S-ATC] [S-SPC]
130. When a link matches an "is equal to" route exactly, Arc opens it in that route's Space. Links that do not match exactly are not routed. [S-ATC]
131. When the Air Traffic Control "Default" dropdown is set to "Most Recent Space", Arc opens unmatched external links in the last used Space instead of Little Arc. [S-ATC]
132. When the user clicks the minus button next to a route, Arc deletes it. Arc also removes routes automatically when their Space is deleted. [S-ATC]
133. When the user types "Open Link Preferences" in ⌘T, Arc opens Settings > Links, where the Air Traffic Control panel is. [S-ATC]

PICTURE-IN-PICTURE / MINI PLAYER / MEDIA
134. When a tab is playing video and the user switches to another tab, Arc shows a mini player with the video in the bottom-right corner. [S-MINI] [S-RN21]
135. When the user right-clicks a video twice and chooses Picture in Picture, Arc opens the mini player by hand. [S-MINI]
136. When the user drags a corner of the mini player, Arc resizes it. ⌘-scroll or a pinch zooms the video. [S-MINI] [S-RN23]
137. When Picture-in-Picture or Mini Player is unchecked for a site in the Site Control Center, Arc stops showing the mini player for that site. A global switch is in Settings > Advanced. [S-MINIOFF] [S-MINI] [S-RN23]
138. When a tab is playing audio and the user switches away, Arc shows a small audio controller at the bottom of the sidebar, and clicking its X removes it. [S-MINI]
139. When the user leaves a Google Meet tab during a call, Arc automatically opens the call in Picture-in-Picture. [S-RN23]
140. When Picture-in-Picture is open, Arc still shows alerts and modals in the Arc window. [S-RN24]

DOWNLOADS / LIBRARY
141. When the user types "Open Library" in ⌘T or clicks the Library icon at the bottom left of the sidebar, Arc opens the Library with Media, Downloads, Spaces and Archived Tabs sections. It opens on the section used last. [S-LIB] [S-RN23]
142. When a download is in progress, Arc shows its size, time left and a cancel button at the bottom of the sidebar. [S-RN23]
143. When the user changes the download location under Settings > Profiles > [profile], Arc saves that profile's downloads to the new folder. [S-DL]

Unverified (inferred, not stated in any source found):
U1. When a pinned tab is closed with ⌘W, Arc keeps it in the sidebar and only unloads it. No source describes ⌘W on pinned tabs.
U2. When ⌘W is pressed on an unpinned tab, Arc sends it to the Archive. The Library says closed tabs appear in Archived Tabs, but this shortcut is not spelled out.
U3. When a new tab is opened from ⌘T, Arc places it at the top of the Unpinned/Today section.
U4. When the command bar is open and the user presses Esc, Arc closes it.
U5. When the user presses Return on a command bar entry that matches an open tab, Arc switches to that tab instead of opening a duplicate.
U6. When the user presses ⌘O in the main window, Arc shows a file-open dialog. Sources only describe ⌘O for Little Arc and Peek.
U7. When the user switches Spaces, Arc swaps the active profile and its cookies along with the Space. This follows from per-Space profiles but is not stated as a test.
U8. When the user presses ⌃9, Arc goes to the last Space.
U9. The name "Today" for the unpinned section appears only in 2024 release notes and is not documented as a feature.
U10. ⌘E as an alternative command bar shortcut is from 2021–2022 release notes and may be outdated.

Sources
S-PIN https://resources.arc.net/hc/en-us/articles/19231060187159-Pinned-Tabs-Tabs-you-want-to-stick-around
S-FAV https://resources.arc.net/hc/en-us/articles/19230755904151-Favorites-Top-Tabs-Across-Every-Space
S-FOLD https://resources.arc.net/hc/en-us/articles/19228419623447-Folders-Stash-Similar-Tabs-Together
S-ARCH https://resources.arc.net/hc/en-us/articles/19228855311127-Auto-Archive-Clean-as-you-go
S-LIB https://resources.arc.net/hc/en-us/articles/19230634389911-Library-A-home-for-your-downloads-archived-tabs-easels-and-more
S-SPC https://resources.arc.net/hc/en-us/articles/19228064149143-Spaces-Distinct-Browsing-Areas
S-PROF https://resources.arc.net/hc/en-us/articles/19227964556183-Profiles-Separate-Work-Personal-Browsing
S-MINI https://resources.arc.net/hc/en-us/articles/19234766331799-Mini-Player-Watch-or-Listen-as-you-Browse
S-MINIOFF https://resources.arc.net/hc/en-us/articles/25590734716823-How-Do-You-Disable-Mini-Player-on-Arc-for-Desktop
S-LA https://resources.arc.net/hc/en-us/articles/19235387524503-Little-Arc-Quick-Lookups-Instant-Triaging
S-PEEK https://resources.arc.net/hc/en-us/articles/19335302900887-Peek-Preview-Sites-From-Pinned-Tabs
S-SPLIT https://resources.arc.net/hc/en-us/articles/19335393146775-Split-View-View-Multiple-Tabs-at-Once
S-KB https://resources.arc.net/hc/en-us/articles/20595231349911-Keyboard-Shortcuts
S-SITE https://resources.arc.net/hc/en-us/articles/20855018192791-Site-Search-Directly-Search-any-Website
S-ATC https://resources.arc.net/hc/en-us/articles/22932014625431-Air-Traffic-Control-Automate-Your-Link-Routing
S-CBX https://resources.arc.net/hc/en-us/articles/25500065173399-How-Do-You-Remove-Suggested-Command-Bar-URLs-in-Arc-for-Desktop
S-REVERT https://resources.arc.net/hc/en-us/articles/25541939922199-Why-Are-My-Pinned-Tabs-and-Favorites-Reverting-Back-to-Their-Original-URL-in-Arc-for-Desktop
S-WIN https://resources.arc.net/hc/en-us/articles/25590417429783-Why-Are-the-Same-Tabs-Appearing-Across-Multiple-Arc-Windows
S-HIST https://resources.arc.net/hc/en-us/articles/25591309234199-How-Do-I-View-My-Tab-History-in-Arc-for-Desktop
S-DL https://resources.arc.net/hc/en-us/articles/25614213458711-How-Do-You-Change-Your-Download-Location-in-Arc-for-Desktop
S-SWITCH https://resources.arc.net/hc/en-us/articles/25619402657303-How-Do-You-Switch-Between-Tabs-Quickly-on-Arc-Desktop
S-HIDE https://resources.arc.net/hc/en-us/articles/25619487530519-How-Do-You-Hide-the-Sidebar
S-RESTORE https://resources.arc.net/hc/en-us/articles/25625071960215-How-Do-I-Restore-My-Tabs-on-Arc-for-Desktop
S-SLASH https://resources.arc.net/hc/en-us/articles/25625148480279-Why-is-There-a-Slash-Next-to-My-Pinned-Tab-s-Name
S-THEME https://resources.arc.net/hc/en-us/articles/25625261733143-How-Do-I-Restore-the-Default-Theme-for-Arc-for-Desktop
S-URL https://resources.arc.net/hc/en-us/articles/25625458052247-How-Do-You-View-the-Full-URL-at-the-Top-of-the-Page-in-Arc-for-Desktop
S-RN24 https://resources.arc.net/hc/en-us/articles/20498293324823-Arc-for-macOS-2024-2026-Release-Notes
S-RN23 https://resources.arc.net/hc/en-us/articles/20498377604887-Arc-for-macOS-2023-Release-Notes
S-RN22 https://resources.arc.net/hc/en-us/articles/20498417809815-Arc-for-macOS-2022-Release-Notes
S-RN21 https://resources.arc.net/hc/en-us/articles/20498463803799-Arc-for-macOS-2021-Release-Notes

Two articles could not be found in any snapshot: "How to Set Custom Keyboard Shortcuts" (25622899860631) and "Open Incognito Window" (22354398337687). Release-note items describe when a behaviour was introduced, so a few of them may have changed later. The extracted text of every article is in /private/tmp/claude-501/-Users-dmitryafonchenko-repos-ai-hub/ef3827b0-b381-44a6-8e80-c33c99c0472a/scratchpad/all.txt. No project files were changed.