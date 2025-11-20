package me.leopetrovic.fsretimetablenotify.messaging;

import me.leopetrovic.fsretimetablenotify.timetable.models.TimetableEvent;
import me.leopetrovic.fsretimetablenotify.timing.TimingService.TimetableDifference;

import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

/**
 * Builds concise human-readable summaries of timetable changes suitable for push notifications.
 */
public final class TimetableChangeSummaryFormatter {
    private static final int MAX_DETAIL_LINES = 3;
    private static final DateTimeFormatter TIME_FORMATTER = DateTimeFormatter.ofPattern("EEE HH:mm")
        .withZone(ZoneOffset.UTC);
    private static final Comparator<TimetableEvent> EVENT_COMPARATOR = Comparator
        .comparing(TimetableEvent::getStartDateTime, Comparator.nullsLast(Comparator.naturalOrder()))
        .thenComparing(TimetableEvent::getName, Comparator.nullsLast(String::compareTo));

    private TimetableChangeSummaryFormatter() {
    }

    public static String buildSummary(TimetableDifference difference) {
        if (difference == null || (difference.newEvents().isEmpty() && difference.removedEvents().isEmpty())) {
            return "No timetable changes detected.";
        }

        var summaryParts = new ArrayList<String>();
        summaryParts.add(formatCount(difference.newEvents().size(), "added class"));
        summaryParts.add(formatCount(difference.removedEvents().size(), "removed class"));
        summaryParts.removeIf(String::isBlank);

        var builder = new StringBuilder();
        if (!summaryParts.isEmpty()) {
            builder.append(String.join(", ", summaryParts)).append('.');
        }

        var detailLines = buildDetailLines(difference);
        if (!detailLines.isEmpty()) {
            if (!builder.isEmpty()) {
                builder.append(' ');
            }
            builder.append(String.join("; ", detailLines));
        }

        return builder.toString();
    }

    public static List<String> buildDetailLines(TimetableDifference difference) {
        if (difference == null) {
            return List.of();
        }
        var detailLines = new ArrayList<String>();
        addDetails(difference.newEvents(), '+', detailLines);
        addDetails(difference.removedEvents(), '-', detailLines);
        return List.copyOf(detailLines);
    }

    private static String formatCount(int size, String label) {
        if (size == 0) {
            return "";
        }
        return size + " " + label + (size == 1 ? "" : "es");
    }

    private static void addDetails(
        Set<TimetableEvent> events,
        char prefix,
        List<String> detailLines
    ) {
        events.stream()
            .sorted(EVENT_COMPARATOR)
            .forEach(event -> {
                if (detailLines.size() < MAX_DETAIL_LINES) {
                    detailLines.add(formatEventDetail(event, prefix));
                }
            });
    }

    private static String formatEventDetail(TimetableEvent event, char prefix) {
        var name = event.getName() == null ? "Class" : event.getName();
        var start = event.getStartDateTime();
        var timeLabel = start == null ? "time TBD" : TIME_FORMATTER.format(start);
        var location = event.getClassRoomNames().isEmpty() ? "" : " @" + event.getClassRoomNames().getFirst();
        return prefix + " " + name + " " + timeLabel + location;
    }
}
