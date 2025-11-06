package me.leopetrovic.fsretimetablenotify.messaging.models;

import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.media.Schema.RequiredMode;
import jakarta.persistence.*;
import lombok.Data;

import java.time.LocalDateTime;
import java.util.Optional;
import java.util.UUID;

@Entity
@Table(name = "messaging_subscriptions")
@Schema(description = "A subscription to receive messages")
@Data
public class MessagingSubscription {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", updatable = false, nullable = false, unique = true)
    @Schema(
        description = "The ID of the subscription",
        requiredMode = RequiredMode.REQUIRED
    )
    private UUID id;

    @Column(name = "fcm_token")
    @Schema(description = "The FCM token of the subscription")
    private String fcmToken;

    @Column(name = "email")
    @Schema(description = "The email of the subscription")
    private String email;

    @Column(name = "study_program_id", nullable = false)
    @Schema(
        description = "The ID of the study program to subscribe to",
        requiredMode = RequiredMode.REQUIRED
    )
    private Long studyProgramId;

    @Column(name = "device_info", nullable = false)
    @Schema(
        description = "Information about the subscriber's device",
        requiredMode = RequiredMode.REQUIRED
    )
    private String deviceInfo;

    @Column(name = "created_at", nullable = false, updatable = false)
    @Schema(
        description = "The timestamp when the subscription was created",
        requiredMode = RequiredMode.REQUIRED
    )
    private LocalDateTime createdAt;

    @Column(name = "last_notified_at")
    @Schema(
        description = "The timestamp when the subscriber was last notified",
        requiredMode = RequiredMode.NOT_REQUIRED
    )
    private LocalDateTime lastNotifiedAt;

    public Optional<String> getFcmToken() {
        return Optional.ofNullable(fcmToken);
    }

    public Optional<String> getEmail() {
        return Optional.ofNullable(email);
    }
}
