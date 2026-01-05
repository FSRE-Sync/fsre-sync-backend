package me.leopetrovic.fsretimetablenotify.timetable.transformers;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.SerializerProvider;
import me.leopetrovic.fsretimetablenotify.timetable.dto.ExternalFsreTimetableRequest;
import org.springframework.boot.jackson.JsonComponent;

import java.io.IOException;
import java.time.DayOfWeek;

@JsonComponent
public class ExternalTimetableRequestSerializer extends JsonSerializer<ExternalFsreTimetableRequest> {
    @Override
    public void serialize(
        ExternalFsreTimetableRequest value,
        JsonGenerator gen,
        SerializerProvider serializers
    ) throws IOException {
        gen.writeStartObject();
        gen.writeArrayFieldStart("__args");
        gen.writeNull();

        gen.writeStartObject();
        gen.writeStringField("datefrom",
            value.yearWeek().atDay(DayOfWeek.MONDAY).toString());
        gen.writeStringField("dateto",
            value.yearWeek().atDay(DayOfWeek.SUNDAY).toString());
        gen.writeStringField("id", value.studyProgramId().toString());
        gen.writeStringField("table", "classes");
        if (value.yearWeek().getWeek() <= 26) {
            gen.writeNumberField("year", value.yearWeek().getYear() - 1);
        } else {
            gen.writeNumberField("year", value.yearWeek().getYear());
        }
        gen.writeEndObject();

        gen.writeEndArray();
        gen.writeStringField("__gsh", "00000000");
        gen.writeEndObject();
    }
}