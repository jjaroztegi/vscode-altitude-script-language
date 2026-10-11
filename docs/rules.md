# Diagnostic rules

Every diagnostic shows its rule id. You can change a rule's severity or turn it off in settings:

```jsonc
"altitudeScriptLanguage.lint.rules": {
    "unused-declaration": "off",
    "popup-then-goto": "error"
}
```

Valid values are `off`, `hint`, `info`, `warning` and `error`. Inside a block of actions you can also suppress one line:

```asl
comment {asl-disable-next-line unreachable-code}
x := 1
```

To suppress rules for the whole file, put `comment {asl-disable rule-id, other-rule}` at the top.

Rules about the Agent Portal can be turned off together with `altitudeScriptLanguage.webEdition: false`, for scripts that never run there.

## Syntax

### syntax
**Error.** The text is not valid ASL: an unclosed brace, a missing `then`, an unterminated string and so on.

### unknown-action
**Error.** A statement does not start with a known action, assignment or control-flow keyword. This is usually a typo (`sett timer`) or a missing `:=`.

### unknown-clause
**Warning.** A graphical element contains a clause that the 8.7 reference does not document for that element.

## Names and references

### unresolved-name
**Error.** A variable, constant, cursor, subroutine, function, enumeration member or built-in attribute is not declared in the scope, the node's masters, the script or its imported modules. ASL names are case-insensitive.

### unresolved-type
**Error.** A type name is not a built-in type, a declared type or a type from an imported module.

### unresolved-member
**Error.** A record field does not exist on a record type declared in the script or its modules. Built-in records are never reported, because the documentation can miss fields.

### unresolved-node
**Error.** `goto node`, `call node`, `master`, `open window` or `open tab node` names a node that the script and its modules do not declare. Names built with `$(...)` are not checked.

### unresolved-event
**Warning.** `trigger event`, `set timer ... trigger event` or `on close trigger event` names an event that no node handles with `on event`.

### unresolved-control
**Warning.** A graphical element action (`graphical element 'x'`, `input 'x'`, `email editor 'x'`...) names an element that no node declares.

### unresolved-image
**Warning.** An image is used but not declared in `dependencies`.

### unresolved-block
**Error.** A container uses a block that is not declared.

### missing-import
**Error.** A module in `modules { import <"..."> }` cannot be found next to the importing file.

### module-kind
**Error.** Agent scripts can import agent modules (`.agm`) and generic modules (`.gem`); IVR scripts can import IVR modules (`.irm`) and generic modules; generic modules can only import generic modules, cannot declare nodes and cannot navigate between nodes.

## Calls and declarations

### argument-count
**Error.** A subroutine, function or built-in is called with the wrong number of arguments.

### invalid-call
**Error.** A subroutine is used as a value. Only functions return values; call subroutines with `call`.

### duplicate-declaration
**Error.** Two declarations in one scope have the same name. ASL names are case-insensitive, so `vTotal` and `vtotal` are the same variable.

### duplicate-node-id
**Warning.** Two nodes have the same `id`.

### shadowed-declaration
**Warning.** A node variable, cursor or routine has the same name as a script or module declaration. Inside the node the outer one is unreachable, so assignments do not reach it.

### unused-declaration
**Hint.** A local, node or script declaration is never used. Public module declarations are not checked, since other scripts may use them.

### unreachable-code
**Hint.** Actions after `goto node`, `call node`, `back node`, `return node`, `return`, `break loop`, `end script`, `abort script`, `discard script` or `restart script` in the same block never run.

### unknown-event
**Warning.** A handler is not a documented event of the node or of the graphical element. User-defined events take one name (`on event Name()`); multi-word names are reserved for predefined events.

### misplaced-handler
**Warning.** A handler is declared where it never runs: `on enter` outside a node, `on start` in a module, `on load` in a script.

### navigation-in-exit
**Error.** `on exit`, `on end` and `on unload` ignore node navigation.

### script-start
**Warning.** A script has no `on start`, or its `on start` never moves to a node.

### control-clause
**Warning.** A graphical element lacks its `size` clause, or an input, combo box, check box, radio button or table lacks its `for` binding.

## Agent Portal (ASL Web Edition)

### web-unsupported
**Warning** (modal windows: **error**). The construct was dropped or is not supported in ASL Web Edition: modal windows, function keys, `run application`, `folder_browser`, `current_url`, `current_html`, legacy web browser and email editor actions, web browser events, and email editor clauses from ASL for Windows.

### deprecated
**Hint.** Deprecated or renamed constructs: `rgbcolor` (now `rgb_color`), script `parameters`, the chat control and its actions (replaced by the media panel), deprecated instant messaging events and actions, and IVR audio resources.

### native-dll
**Info.** A native DLL dependency, or a module that wraps one. In ASL Web Edition native DLLs run on the web server and must be 32-bit. Prefer a managed DLL (`dll managed`) or a web service dependency.

### overlay-position
**Info.** An overlay window with a fixed `at x,y`. Without `at` the Agent Portal centres the overlay; positions copied from old modal windows can place it off-screen on small viewports. The quick fix removes the clause.

## Asynchronous popups

In the Agent Portal, `open window ... overlay` and `open message box` do not wait for the agent: the actions after them run immediately, and the window behind the popup is disabled until it closes. Handle the answer in the event named by `on close trigger event`.

### popup-then-goto
**Warning.** Node navigation after opening a popup on the same path fails at run time. Move it to the popup's `on close` event handler. It is reported as **info** when the popup comes from a called subroutine that only may open one.

### popup-then-popup
**Warning.** A second popup while the first is open does not stack. Open it from the first popup's `on close` event handler.

### overlay-in-enter
**Warning.** A popup opened directly in `on enter` or `on first enter` races with the node being displayed. Defer it with `set timer to 1 trigger event Open` and open it in `on event Open()`.

### overlay-result-read
**Warning.** A variable passed to a `ref` parameter of the overlay node is read right after `open window`, before the agent answers.

### async-function-result
**Warning.** A function that opens a popup returns before the agent answers, so its value cannot contain the answer.

### email-async
**Warning.** Email editor actions are asynchronous in the Agent Portal. Actions right after `load email` do not work (use `on email loaded`), and setting the same field twice in one block replaces the first value; to append to the body use `insert html into body`.

### button-shadows-master
**Warning.** A push button without click actions sits at the same position as an inherited master button: it takes the click, and the master's action never runs.

## Workspace

### unreachable-module
**Hint.** No script or module in the workspace imports this module.

### encoding
**Warning.** Reported by the VS Code extension and the command-line checker, not the language server. The file is not UTF-8 with BOM, or uses LF line endings. Script Developer saves ASL files as UTF-8 with BOM and CRLF.
