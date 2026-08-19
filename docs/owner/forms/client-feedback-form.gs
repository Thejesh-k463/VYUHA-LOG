/**
 * Vyuha — client feedback Google Form builder.
 * Source of truth: docs/owner/CLIENT_FEEDBACK_FORM.md (owner-edited 2026-08-19).
 *
 * HOW TO RUN (one time, ~2 minutes):
 *   1. Open https://script.google.com -> "New project".
 *   2. Delete the stub, paste this whole file, Ctrl+S.
 *   3. Run > createVyuhaFeedbackForm -> approve the Forms/Drive permission prompt (your own account).
 *   4. View > Logs: it prints the EDIT url and the SHARE url. The form lands in your Google Drive root.
 *   5. Open the edit url once: Responses tab -> link a Sheet; add columns "Version", "Followed up (date)".
 *   6. Share the SHARE url (the /viewform one) on WhatsApp after purchase.
 * Re-running creates a second form - delete the first in Drive if you iterate.
 */
function createVyuhaFeedbackForm() {
  var form = FormApp.create("Vyuha - tell us how it is going");
  form.setDescription(
    "About 5 minutes. This helps us support you, fix what matters, and decide what to build next. " +
    "We never ask for API keys, TOTP secrets, PAN or account numbers - please do not paste them anywhere here. " +
    "Reply lands on WhatsApp within a day. Nothing you type is shared."
  );
  form.setCollectEmail(false);          // ask explicitly instead (Q2)
  form.setLimitOneResponsePerUser(false);
  form.setProgressBar(true);
  form.setConfirmationMessage("Thank you - reply lands on WhatsApp within a day. Nothing you typed is shared.");
  form.setShowLinkToRespondAgain(false);

  var WA = "If anything here goes wrong in the next days or weeks of use, message us on WhatsApp +91 73936 73714 - we check and fix.";

  // -- Section 1 - About you (required)
  form.addSectionHeaderItem().setTitle("1 - About you").setHelpText("Only this block is required.");
  form.addTextItem().setTitle("Name").setRequired(true);
  form.addTextItem().setTitle("Email").setRequired(true)
      .setValidation(FormApp.createTextValidation().requireTextIsEmail().build());
  form.addTextItem().setTitle("WhatsApp number (optional)");
  form.addTextItem().setTitle("City").setRequired(true);
  form.addMultipleChoiceItem().setTitle("Which best describes you?").setRequired(true)
      .setChoiceValues(["Intraday", "Swing / positional", "Options seller", "Options buyer",
                        "Long-term investor with some trading", "Full-time trader", "Part-time"]);
  form.addCheckboxItem().setTitle("Brokers you actively use").setRequired(true)
      .setChoiceValues(["Zerodha", "Dhan", "Groww", "Angel One", "Upstox", "Paytm Money", "Kotak Neo", "Sahi", "ICICI Direct", "HDFC Sky"])
      .showOtherOption(true);
  form.addMultipleChoiceItem().setTitle("Approximate trades per month").setRequired(true)
      .setChoiceValues(["Under 20", "20-100", "100-500", "500+"]);
  form.addCheckboxItem().setTitle("Segments you trade").setRequired(true)
      .setChoiceValues(["Equity delivery", "Intraday", "Equity MTF", "Index options", "Stock options", "Futures", "MCX commodities", "Currency"]);

  // -- Section 2 - How you found and use Vyuha
  form.addPageBreakItem().setTitle("2 - How you found and use Vyuha");
  form.addMultipleChoiceItem().setTitle("How did you hear about Vyuha?")
      .setChoiceValues(["WhatsApp", "A creator (tell us who below)", "X / Twitter", "GitHub", "A friend", "Search"])
      .showOtherOption(true);
  form.addTextItem().setTitle("If a creator - who?");
  form.addTextItem().setTitle("Vyuha version you are on")
      .setHelpText("Settings > License, or the sidebar footer (e.g. v2.99.97).");
  form.addMultipleChoiceItem().setTitle("Your plan").setChoiceValues(["Pro - Annual", "Journal - Lifetime"]);
  form.addCheckboxItem().setTitle("How did you get your trades in?")
      .setHelpText(WA)
      .setChoiceValues(["Zerodha file", "Dhan file", "Groww file", "Angel One file", "Upstox file", "Paytm Money file",
                        "Column mapper (tell us which broker in the next box)", "Kite API", "Dhan API", "Angel One API", "Typed by hand"]);
  form.addTextItem().setTitle("If column mapper - which broker?");
  form.addMultipleChoiceItem().setTitle("Did the import work first time?")
      .setHelpText(WA)
      .setChoiceValues(["Yes", "Needed the column mapper", "Wrong numbers", "Failed"]);
  form.addParagraphTextItem().setTitle("If not - what happened?")
      .setHelpText("Describe it; if you have a screenshot, send a REDACTED one on WhatsApp - never the broker file itself.");
  form.addMultipleChoiceItem().setTitle("Do the charges Vyuha computed match your contract note?")
      .setHelpText(WA)
      .setChoiceValues(["Yes, within a rupee", "Off by a small amount", "Off by a lot", "Didn't check"]);

  // -- Section 3 - What matters
  form.addPageBreakItem().setTitle("3 - What matters").setHelpText("This ranking sets the roadmap.");
  form.addCheckboxItem().setTitle("The five things you use most (pick up to 5)")
      .setChoiceValues(["Dashboard / KPIs", "Trades table", "Staged positions", "Options Seller Journal", "Portfolio risk",
                        "Tax pack (ITR / AIS / advance tax)", "Arjun's Eye / Discipline", "Lenses / Edge", "Playbooks",
                        "Trade calculator", "Charges & MTF comparison", "Backup / restore", "Appearance (skins, tint, custom theme, wallpaper)"])
      .setValidation(FormApp.createCheckboxValidation().requireSelectAtMost(5).build());
  form.addParagraphTextItem().setTitle("What is missing that would make you open Vyuha every day? (optional)");
  form.addTextItem().setTitle("Which broker would you most like connected next - and how: file, API, or manual entry is fine?");
  form.addMultipleChoiceItem().setTitle("Would a Mac or web version matter to you?")
      .setChoiceValues(["No", "Nice to have", "I can't use it without"]);

  // -- Section 4 - Trust
  form.addPageBreakItem().setTitle("4 - Trust");
  form.addMultipleChoiceItem().setTitle("Which matters more to you?")
      .setChoiceValues(["My data stays on my own machine", "Access from any device"]);
  form.addScaleItem().setTitle("How likely are you to recommend Vyuha to a trading friend?")
      .setBounds(0, 10).setLabels("Not at all", "Definitely");

  // -- Section 5 - Consent and follow-up
  form.addPageBreakItem().setTitle("5 - Consent and follow-up");
  form.addMultipleChoiceItem().setTitle("May we quote your feedback on the landing page?")
      .setChoiceValues(["Yes, with first name + city", "Yes, anonymously", "No"]);
  form.addMultipleChoiceItem().setTitle("Happy to do a 10-minute call?").setChoiceValues(["Yes", "No"]);
  form.addTextItem().setTitle("If yes - best day/time");
  form.addParagraphTextItem().setTitle("Anything else - bugs, praise, rants.");

  Logger.log("EDIT  : " + form.getEditUrl());
  Logger.log("SHARE : " + form.getPublishedUrl());
  return form.getPublishedUrl();
}
