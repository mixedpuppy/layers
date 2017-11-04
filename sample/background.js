
let open = false;
browser.browserAction.onClicked.addListener(details => {
  if (open)
  browser.overlay.close();
  else
  browser.overlay.open({url: "index.html"});

  open = !open;
});