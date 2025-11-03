package me.leopetrovic.fsretimetablenotify.timing;

import lombok.extern.slf4j.Slf4j;
import me.leopetrovic.fsretimetablenotify.messaging.MessagingService;
import me.leopetrovic.fsretimetablenotify.messaging.dto.TimetableUpdatedMessageDto;
import me.leopetrovic.fsretimetablenotify.messaging.exceptions.EmailSendMessageFailed;
import me.leopetrovic.fsretimetablenotify.messaging.exceptions.FcmSendMessageFailed;
import me.leopetrovic.fsretimetablenotify.messaging.models.MessagingSubscription;
import me.leopetrovic.fsretimetablenotify.timetable.TimetableService;
import me.leopetrovic.fsretimetablenotify.timetable.models.Timetable;
import me.leopetrovic.fsretimetablenotify.timetable.models.TimetableEvent;
import me.leopetrovic.fsretimetablenotify.timetable.models.TimetableKey;
import me.leopetrovic.fsretimetablenotify.timetabledatabase.TimetableDatabaseService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.threeten.extra.YearWeek;

import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

@Slf4j
@Service
public class TimingService {
    private final MessagingService messagingService;
    private final TimetableDatabaseService timetableDatabaseService;
    private final TimetableService timetableService;

    @Autowired
    public TimingService(
        MessagingService messagingService,
        TimetableDatabaseService timetableDatabaseService,
        TimetableService timetableService
    ) {
        this.messagingService = messagingService;
        this.timetableDatabaseService = timetableDatabaseService;
        this.timetableService = timetableService;
    }

    @Scheduled(cron = "0 */15 * * * *")
    public void refreshTimetables() {
        var studyPrograms = timetableDatabaseService.getTimetableDatabase()
            .getStudyPrograms();

        // For each study program
        log.info("Refreshing timetables for {} study programs",
            studyPrograms.size());
        studyPrograms.forEach(studyProgram -> {
            final List<MessagingSubscription> subscribers = messagingService.getAllByStudyProgramId(
                studyProgram.id());

            // If there are no subscriptions for the study program, skip
            if (subscribers.isEmpty()) {
                log.debug(
                    "No subscriptions found for study program {}, skipping",
                    studyProgram.id());
                return;
            } else {
                log.info("Found {} subscriptions for study program {}",
                    subscribers.size(),
                    studyProgram.id());
            }

            // Else, fetch the timetable for the current and next week
            final TimetableKey currentTimetableKey = new TimetableKey(
                studyProgram.id(),
                YearWeek.now());
            final TimetableKey nextTimetableKey = new TimetableKey(studyProgram.id(),
                YearWeek.now().plusWeeks(1));

            for (TimetableKey timetableKey : new TimetableKey[]{
                currentTimetableKey, nextTimetableKey}) {
                log.debug("Fetching timetable for {}", timetableKey);
                timetableService.fetchTimetable(timetableKey)
                    .thenAccept(newTimetable -> {
                        // If a previously cached timetable exists and is different from the previous
                        // fetch, send a message
                        final Optional<Timetable> maybeExistingTimetable = timetableService.getTimetable(
                            timetableKey);
                        if (maybeExistingTimetable.isPresent()) {
                            final Timetable existingTimetable = maybeExistingTimetable.get();

                            final TimetableDifference difference = getDifference(
                                existingTimetable,
                                newTimetable);
                            if (!difference.newEvents.isEmpty() || !difference.removedEvents.isEmpty()) {
                                log.info(
                                    "Timetable for {} has changed - {} changes",
                                    timetableKey,
                                    difference.newEvents.size() + difference.removedEvents.size());

                                // Send a message to each subscriber of the study program
                                messagingService.getAllByStudyProgramId(
                                        studyProgram.id())
                                    .forEach(messagingSubscription -> {
                                        log.debug("Sending message...");

                                        try {
                                            messagingService.sendMessage(
                                                messagingSubscription,
                                                new TimetableUpdatedMessageDto(
                                                    difference,
                                                    timetableKey));
                                        } catch (FcmSendMessageFailed e) {
                                            log.error(
                                                "Couldn't send FCM timetable notification to {}: {}",
                                                messagingSubscription.getFcmToken(),
                                                e.getMessage());
                                        } catch (EmailSendMessageFailed e) {
                                            log.error(
                                                "Couldn't send email timetable notification to {}: {}",
                                                messagingSubscription.getEmail(),
                                                e.getMessage());
                                        }
                                    });
                            } else {
                                log.debug(
                                    "Timetable for {} has not changed, skipping message",
                                    timetableKey);
                            }

                            timetableService.setTimetable(timetableKey,
                                newTimetable);
                        } else {
                            log.info(
                                "No previous timetable found for {} found, skipping message and caching",
                                timetableKey);
                            timetableService.setTimetable(timetableKey,
                                newTimetable);
                        }
                    })
                    .join();
            }
        });

    }

    private TimetableDifference getDifference(
        Timetable existingTimetable,
        Timetable newTimetable
    ) {
        Set<TimetableEvent> newEvents = new HashSet<>();
        Set<TimetableEvent> removedEvents = new HashSet<>();

        // Find new events
        for (List<TimetableEvent> eventsForWeekDay : newTimetable.getWeekDays()) {
            for (TimetableEvent newEvent : eventsForWeekDay) {
                if (existingTimetable.getWeekDays()
                    .stream()
                    .flatMap(List::stream)
                    .noneMatch(existingEvent -> existingEvent.equals(newEvent))) {
                    newEvents.add(newEvent);
                }
            }
        }

        // Find removed events
        for (List<TimetableEvent> eventsForWeekDay : existingTimetable.getWeekDays()) {
            for (TimetableEvent existingEvent : eventsForWeekDay) {
                if (newTimetable.getWeekDays()
                    .stream()
                    .flatMap(List::stream)
                    .noneMatch(newEvent -> newEvent.equals(existingEvent))) {
                    removedEvents.add(existingEvent);
                }
            }
        }

        return new TimetableDifference(newEvents, removedEvents);
    }

    public record TimetableDifference(
        Set<TimetableEvent> newEvents,
        Set<TimetableEvent> removedEvents
    ) {}
}
