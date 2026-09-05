// Intercepts closed shadow roots so the extension can traverse them
const originalAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(options) {
  // Force all shadow roots to be 'open' so the isolated world can read el.shadowRoot
  return originalAttachShadow.call(this, { ...options, mode: 'open' });
};
