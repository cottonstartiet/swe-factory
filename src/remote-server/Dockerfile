FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/remote-server/SweFactory.Remote.Server.csproj src/remote-server/
RUN dotnet restore src/remote-server/SweFactory.Remote.Server.csproj
COPY src/remote-server/ src/remote-server/
COPY dist-remote/ dist-remote/
RUN dotnet publish src/remote-server/SweFactory.Remote.Server.csproj -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
RUN mkdir -p /app/data
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "SweFactory.Remote.Server.dll"]
