# SillyTavern character picker

1. Extend the SillyTavern client with `/api/characters/all` and validate avatar filenames. Keep the existing Viktor card as the default for old profiles.
2. Store the selected avatar filename in the Studio profile and pass it to the bridge at startup. Make bridge conversations and jobs character scoped; expose list/current/select endpoints. Include the selected card's name and core prompt fields in saved chats and model input.
3. Add a character picker in the Studio conversation panel with refresh and selection. Switching while connected creates a new conversation for the chosen card and updates the existing LiveTalking session without restarting GPU services. Disallow switching during recording or an active send. Preserve the previous selection on failure.
4. Add client, bridge, profile, UI smoke tests. Verify against the real SillyTavern API and one temporary second card. Run desktop tests, build, smoke suites, and a short live chat if resources permit.
