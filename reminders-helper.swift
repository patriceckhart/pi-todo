import EventKit
import Foundation

let store = EKEventStore()

func requestAccess() -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    store.requestFullAccessToReminders { g, _ in
        granted = g
        semaphore.signal()
    }
    semaphore.wait()
    return granted
}

func getPiCalendar() -> EKCalendar? {
    return store.calendars(for: .reminder).first(where: { $0.title == "pi" })
}

func getOrCreatePiCalendar() -> EKCalendar? {
    if let cal = getPiCalendar() { return cal }
    let cal = EKCalendar(for: .reminder, eventStore: store)
    cal.title = "pi"
    cal.source = store.defaultCalendarForNewReminders()?.source
    do {
        try store.saveCalendar(cal, commit: true)
        return cal
    } catch {
        return nil
    }
}

func fetchAll(calendar: EKCalendar) -> [EKReminder] {
    let semaphore = DispatchSemaphore(value: 0)
    var result: [EKReminder] = []
    let predicate = store.predicateForReminders(in: [calendar])
    store.fetchReminders(matching: predicate) { reminders in
        result = reminders ?? []
        semaphore.signal()
    }
    semaphore.wait()
    return result
}

func reminderToDict(_ r: EKReminder) -> [String: Any] {
    return [
        "id": r.calendarItemExternalIdentifier ?? "",
        "title": r.title ?? "",
        "body": r.notes ?? "",
        "done": r.isCompleted,
        "priority": r.priority
    ]
}

func output(_ value: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: value),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

func fail(_ msg: String) -> Never {
    let err: [String: Any] = ["error": msg]
    output(err)
    exit(1)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

guard requestAccess() else { fail("Reminders access denied") }

let args = CommandLine.arguments
guard args.count >= 2 else { fail("Usage: reminders-helper <command> [args...]") }

let command = args[1]

switch command {

case "list":
    guard let cal = getPiCalendar() else {
        output([] as [Any])
        exit(0)
    }
    let reminders = fetchAll(calendar: cal)
    let list = reminders.map { reminderToDict($0) }
    output(list)

case "add":
    guard args.count >= 3 else { fail("Usage: reminders-helper add <json>") }
    guard let data = args[2].data(using: .utf8),
          let params = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fail("Invalid JSON")
    }
    guard let cal = getOrCreatePiCalendar() else { fail("Cannot create pi list") }
    let reminder = EKReminder(eventStore: store)
    reminder.calendar = cal
    reminder.title = params["title"] as? String ?? ""
    reminder.notes = params["body"] as? String ?? ""
    reminder.priority = params["priority"] as? Int ?? 0
    do {
        try store.save(reminder, commit: true)
        output(reminderToDict(reminder))
    } catch {
        fail("Save failed: \(error.localizedDescription)")
    }

case "toggle":
    guard args.count >= 3 else { fail("Usage: reminders-helper toggle <id>") }
    let targetId = args[2]
    guard let cal = getPiCalendar() else { fail("pi list not found") }
    let reminders = fetchAll(calendar: cal)
    guard let r = reminders.first(where: { $0.calendarItemExternalIdentifier == targetId }) else {
        fail("Reminder not found")
    }
    r.isCompleted = !r.isCompleted
    do {
        try store.save(r, commit: true)
        output(reminderToDict(r))
    } catch {
        fail("Save failed: \(error.localizedDescription)")
    }

case "update":
    guard args.count >= 4 else { fail("Usage: reminders-helper update <id> <json>") }
    let targetId = args[2]
    guard let data = args[3].data(using: .utf8),
          let params = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fail("Invalid JSON")
    }
    guard let cal = getPiCalendar() else { fail("pi list not found") }
    let reminders = fetchAll(calendar: cal)
    guard let r = reminders.first(where: { $0.calendarItemExternalIdentifier == targetId }) else {
        fail("Reminder not found")
    }
    if let title = params["title"] as? String { r.title = title }
    if let body = params["body"] as? String { r.notes = body }
    if let priority = params["priority"] as? Int { r.priority = priority }
    if let done = params["done"] as? Bool { r.isCompleted = done }
    do {
        try store.save(r, commit: true)
        output(reminderToDict(r))
    } catch {
        fail("Save failed: \(error.localizedDescription)")
    }

case "delete":
    guard args.count >= 3 else { fail("Usage: reminders-helper delete <id>") }
    let targetId = args[2]
    guard let cal = getPiCalendar() else { fail("pi list not found") }
    let reminders = fetchAll(calendar: cal)
    guard let r = reminders.first(where: { $0.calendarItemExternalIdentifier == targetId }) else {
        fail("Reminder not found")
    }
    do {
        try store.remove(r, commit: true)
        output(["ok": true])
    } catch {
        fail("Delete failed: \(error.localizedDescription)")
    }

case "clear":
    guard let cal = getPiCalendar() else {
        output(["count": 0])
        exit(0)
    }
    let reminders = fetchAll(calendar: cal)
    let count = reminders.count
    for r in reminders {
        try? store.remove(r, commit: false)
    }
    try? store.commit()
    output(["count": count])

default:
    fail("Unknown command: \(command). Use: list, add, toggle, update, delete, clear")
}
