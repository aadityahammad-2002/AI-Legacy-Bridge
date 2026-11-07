FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml ./
COPY src/ ./src/
RUN mvn --batch-mode --no-transfer-progress -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /build/target/legacy-bridge-backend-0.1.0.jar /app/app.jar
COPY docker-application.properties /app/config/application.properties
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar", "--spring.config.additional-location=file:/app/config/"]
