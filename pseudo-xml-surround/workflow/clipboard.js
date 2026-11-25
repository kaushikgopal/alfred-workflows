ObjC.import('AppKit');

const snapshotPrefix = 'local.kaush.alfred.pseudo-xml-prompt.';
const snapshotCountType = $(snapshotPrefix + 'change-count');
const alfredClippingType = $('com.runningwithcrayons.alfred.clipping');
const transientType = $('org.nspasteboard.TransientType');

function copyItems(items, start = 0) {
  if (items.isNil()) throw new Error('Could not read the clipboard.');
  const copies = [];
  for (let i = start; i < items.count; i++) {
    const original = items.objectAtIndex(i);
    const copy = $.NSPasteboardItem.alloc.init;
    for (let j = 0; j < original.types.count; j++) {
      const type = original.types.objectAtIndex(j);
      const data = original.dataForType(type);
      if (data.isNil() || !copy.setDataForType(data, type)) {
        throw new Error('Could not copy all clipboard representations.');
      }
    }
    copies.push(copy);
  }
  return copies;
}

function snapshotClipboard(clipboard, snapshot) {
  const count = clipboard.changeCount;
  const copies = copyItems(clipboard.pasteboardItems);
  const metadata = $.NSPasteboardItem.alloc.init;
  if (!metadata.setStringForType($(String(count)), snapshotCountType) ||
      !snapshot.writeObjects($([metadata, ...copies]))) {
    throw new Error('Could not save the clipboard.');
  }
  if (clipboard.changeCount !== count) {
    throw new Error('The clipboard changed while saving it.');
  }
}

function sameItems(items, copies) {
  if (items.isNil() || Number(items.count) !== copies.length) return false;
  return copies.every((copy, i) => {
    const item = items.objectAtIndex(i);
    if (!item.types.isEqualToArray(copy.types)) return false;
    for (let j = 0; j < copy.types.count; j++) {
      const type = copy.types.objectAtIndex(j);
      if (!copy.dataForType(type).isEqualToData(item.dataForType(type))) return false;
    }
    return true;
  });
}

function restoreClipboard(clipboard, snapshot, waitForPaste) {
  const items = snapshot.pasteboardItems;
  if (items.isNil() || Number(items.count) === 0) throw new Error('Clipboard snapshot is missing.');
  const savedCount = ObjC.unwrap(items.objectAtIndex(0).stringForType(snapshotCountType));
  if (typeof savedCount !== 'string' || !/^\d+$/.test(savedCount)) {
    throw new Error('Clipboard snapshot is invalid.');
  }

  // Alfred 6's plain-text output declares ownership once, then adds its transient
  // marker without advancing the count. Do not claim any later clipboard write.
  const pasteCount = Number(savedCount) + 1;
  if (Number(clipboard.changeCount) !== pasteCount ||
      !clipboard.types.containsObject(alfredClippingType) ||
      !clipboard.types.containsObject(transientType)) return;

  const pasted = copyItems(clipboard.pasteboardItems);
  const copies = copyItems(items, 1);
  waitForPaste();
  if (!sameItems(clipboard.pasteboardItems, pasted)) return;
  // AppKit has no atomic compare-and-replace. Check immediately before clearing.
  if (Number(clipboard.changeCount) !== pasteCount) return;
  clipboard.clearContents;
  if (copies.length && !clipboard.writeObjects($(copies))) {
    throw new Error('Could not restore the clipboard.');
  }
}

function run(args) {
  if (args[0] === 'save') {
    const id = ObjC.unwrap($.NSUUID.UUID.UUIDString);
    const snapshot = $.NSPasteboard.pasteboardWithName($(snapshotPrefix + id));
    try {
      snapshotClipboard($.NSPasteboard.generalPasteboard, snapshot);
    } catch (error) {
      snapshot.releaseGlobally;
      throw error;
    }
    return JSON.stringify({ alfredworkflow: {
      arg: args[1] ?? '',
      variables: { xml_clipboard_snapshot: id, xml_clipboard_saved: 'yes' }
    }});
  }
  if (args[0] === 'restore') {
    const id = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('xml_clipboard_snapshot'));
    if (typeof id !== 'string' || !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(id)) {
      throw new Error('Clipboard snapshot ID is missing or invalid.');
    }
    const snapshot = $.NSPasteboard.pasteboardWithName($(snapshotPrefix + id));
    try {
      // This action starts when Alfred schedules Cmd+V, not when the target app
      // has read the clipboard. Leave time for the paste and caret movement.
      restoreClipboard($.NSPasteboard.generalPasteboard, snapshot,
        () => $.NSThread.sleepForTimeInterval(0.5));
    } finally {
      snapshot.releaseGlobally;
    }
    return;
  }
  throw new Error('Expected save or restore.');
}
