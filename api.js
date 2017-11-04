/* -*- Mode: indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set sts=2 sw=2 et tw=80: */
"use strict";

const {classes: Cc, interfaces: Ci, results: Cr, utils: Cu} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "ExtensionParent",
                              "resource://gre/modules/ExtensionParent.jsm");

let {
  windowTracker,
  WindowListManager,
  makeWidgetId
} = ExtensionParent.apiManager.global;

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

// WeakMap[Extension -> Overlay]
var overlayMap = new WeakMap();

class Overlay {
  static for(extension) {
    return overlayMap.get(extension);
  }

  constructor(extension) {
    this.extension = extension;

    let widgetId = makeWidgetId(extension.id);
    this.id = `${widgetId}-overlay`;
    overlayMap.set(extension, this);
  }

  buildBrowser(window) {
    let document = window.document;
    let stack = document.getElementById("appcontent");
    let height = stack.getBoundingClientRect().height;
    // We might consider just having a single browser element per window, and
    // loading whatever extension calls overlay.open first.  For simplicity
    // right now, just create one when need it, toss when on close.
    let browser = document.createElementNS(XUL_NS, "browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("flex", "1");
    browser.setAttribute("disableglobalhistory", "true");
    browser.setAttribute("webextension-view-type", "overlay");
    browser.setAttribute("context", "contentAreaContextMenu");
    browser.setAttribute("tooltip", "aHTMLTooltip");
    browser.setAttribute("autocompletepopup", "PopupAutoComplete");
    browser.setAttribute("selectmenulist", "ContentSelectDropdown");
    browser.setAttribute("onclick", "contentAreaClick(event, true);");
    // XXX fix top location, figure out how to force opacity on the document
    // background
    browser.setAttribute("style", `margin-top: -${height}px; padding: 10px; opacity: 0.5; background-color: rgba(255,0,0,.5);`);

    let readyPromise;
    if (this.extension.remote) {
      browser.setAttribute("remote", "true");
      browser.setAttribute("remoteType", E10SUtils.EXTENSION_REMOTE_TYPE);
      readyPromise = promiseEvent(browser, "XULFrameLoaderCreated");

      window.messageManager.addMessageListener("contextmenu", openContextMenu);
      window.addEventListener("unload", () => {
        window.messageManager.removeMessageListener("contextmenu", openContextMenu);
      }, {once: true});
    } else {
      readyPromise = Promise.resolve();
    }

    let vbox = document.createElementNS(XUL_NS, "hbox");
    vbox.setAttribute("id", this.id);
    vbox.setAttribute("layer", "true");
    vbox.setAttribute("mousethrough", "never");
    //vbox.setAttribute("collapsed", "true");
    vbox.appendChild(browser);
    stack.appendChild(vbox);

    return readyPromise.then(() => {
      browser.messageManager.loadFrameScript("chrome://browser/content/content.js", false);
      ExtensionParent.apiManager.emit("extension-browser-inserted", browser);
  
      browser.messageManager.loadFrameScript(
        "chrome://extensions/content/ext-browser-content.js", false);

      browser.messageManager.sendAsyncMessage("Extension:InitBrowser", {
        stylesheets: ExtensionParent.extensionStylesheets,
      });
      return browser;
    });    
  }

  async open(window, url) {
    // TODO if webextension-view-type==overlay exists in window, throw
    let document = window.document;
    let browser = document.getElementById(this.id);
    if (!browser) {
      browser = await this.buildBrowser(window);
    }
    browser.removeAttribute("hidden");
    browser.loadURI(url);
  }

  close(window) {
    // for now, we just remove the overlay browser.  We could just hide it, and
    // remove or update it if this or another extension calls open.
    let document = window.document;
    let browser = document.getElementById(this.id);
    if (browser) {
      browser.remove();
    }
  }

  shutdown() {
    for (let window of WindowListManager.browserWindows()) {
      let {document} = window;
      let browser = document.getElementById(this.id);
      if (browser) {
        browser.remove();
      }
    }
  }
}

ExtensionParent.apiManager.on("shutdown", (type, extension) => {
  // TODO remove any overlays owned by the extension
  Overlay.for(extension).shutdown();
});

class API extends ExtensionAPI {
  getAPI(context) {
    let {extension} = context;
    if (!overlayMap.get(extension)) {
      overlayMap[extension] = new Overlay(extension);
    }

    return {
      overlay: {
        open(details) {
          // Only one overlay is allowed to be open, first open wins.  Any
          // consective open should throw an error.  The extension should
          // probably only ever have one url loaded so we can keep the browser
          // around, and it can react to whichever tab is selected, saving state
          // for one tab when switching to another.
          // This should possibly only be usable if it is a user initiated event.
          let window = context.currentWindow || windowTracker.topWindow;
          //let window = windowTracker.getWindow(details.windowId, context);
          let url = details.url && context.uri.resolve(details.url);
          Overlay.for(extension).open(window, url);
        },
        close(details) {
          let window = context.currentWindow || windowTracker.topWindow;
          Overlay.for(extension).close(window);
        },
      },
    };
  }
}
