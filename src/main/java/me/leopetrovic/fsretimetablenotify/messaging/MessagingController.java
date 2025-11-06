package me.leopetrovic.fsretimetablenotify.messaging;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import me.leopetrovic.fsretimetablenotify.messaging.dto.MessagingSubscribeDto;
import me.leopetrovic.fsretimetablenotify.messaging.models.MessagingSubscription;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/messaging")
@Validated
public class MessagingController {
    private final MessagingService messagingService;

    @Autowired
    public MessagingController(MessagingService messagingService) {
        this.messagingService = messagingService;
    }

    @PostMapping("/subscribe")
    @ResponseStatus(HttpStatus.OK)
    @Operation(summary = "Subscribe to a study program using an email and/or FCM token")
    @ApiResponses(
        value = {@ApiResponse(
            responseCode = "200",
            description = "Successfully subscribed to a topic",
            content = {@Content(
                mediaType = "application/json",
                schema = @Schema(implementation = MessagingSubscription.class)
            )}
        )}
    )
    public ResponseEntity<MessagingSubscription> subscribe(
        HttpServletRequest request,
        @RequestBody
        @Valid
        MessagingSubscribeDto messagingSubscribeDto,
        @RequestHeader("User-Agent")
        String userAgent
    ) {
        String deviceInfo = userAgent + " | IP: " + request.getRemoteAddr();

        return ResponseEntity.ok(messagingService.subscribe(
            messagingSubscribeDto.email(),
            messagingSubscribeDto.fcmToken(),
            messagingSubscribeDto.studyProgramId(),
            deviceInfo));
    }

    @PostMapping("/unsubscribe")
    @ResponseStatus(HttpStatus.OK)
    @Operation(summary = "Unsubscribe from a study program for a specific email and/or FCM token")
    @ApiResponses(
        value = {@ApiResponse(
            responseCode = "200",
            description = "Successfully unsubscribed from a topic"
        )}
    )
    public ResponseEntity<Void> unsubscribe(
        @RequestBody
        @Valid
        MessagingSubscribeDto messagingSubscribeDto
    ) {
        messagingService.unsubscribe(messagingSubscribeDto.email(),
            messagingSubscribeDto.fcmToken(),
            messagingSubscribeDto.studyProgramId());

        return ResponseEntity.ok().build();
    }
}
