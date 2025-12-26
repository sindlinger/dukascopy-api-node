package com.chanfle.jforexcli;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.StringJoiner;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * JForexCtl
 * CLI client (HTTP + WebSocket) para a API JForex WebSocket/REST.
 *
 * Requer apenas Java 11+ (usa java.net.http).
 *
 * Exemplos:
 *   java -jar jforexctl.jar help
 *   java -jar jforexctl.jar orderbook --rest http://localhost:7080 --instrument EUR/USD --pretty
 *   java -jar jforexctl.jar history --rest http://localhost:7080 --instrument EUR/USD --period M1 --minutes 60 --pretty
 *   java -jar jforexctl.jar instruments list --rest http://localhost:7080
 *   java -jar jforexctl.jar instruments set --rest http://localhost:7080 --list EUR/USD,USD/JPY,BTC/USD
 *   java -jar jforexctl.jar ws --ws ws://localhost:7081/ticker --topOfBook true --instIDs EURUSD,USDJPY --pretty
 */
public class JForexCtl {

    public static void main(String[] args) {
        if (args == null || args.length == 0) {
            usage(0);
            return;
        }

        String cmd = args[0].trim();
        if (cmd.isEmpty() || "help".equalsIgnoreCase(cmd) || "-h".equals(cmd) || "--help".equals(cmd)) {
            usage(0);
            return;
        }

        String[] tail = slice(args, 1);

        try {
            switch (cmd.toLowerCase()) {
                case "history":
                    cmdHistory(tail);
                    break;
                case "orderbook":
                    cmdOrderBook(tail);
                    break;
                case "instruments":
                    cmdInstruments(tail);
                    break;
                case "ws":
                case "websocket":
                case "ticker":
                    cmdWebSocket(tail);
                    break;
                case "position":
                    cmdPosition(tail);
                    break;
                default:
                    System.err.println("Comando desconhecido: " + cmd);
                    usage(2);
            }
        } catch (CliExit e) {
            // saida controlada
            if (e.message != null && !e.message.isBlank()) {
                if (e.code == 0) System.out.println(e.message);
                else System.err.println(e.message);
            }
            System.exit(e.code);
        } catch (Exception e) {
            System.err.println("Erro: " + e.getMessage());
            e.printStackTrace(System.err);
            System.exit(1);
        }
    }

    // -------------------- history --------------------

    private static void cmdHistory(String[] args) throws Exception {
        ParsedArgs pa = ParsedArgs.parse(args);

        String rest = pa.get("rest", envOr("JFOREX_REST", "http://localhost:7080"));
        String instrument = pa.get("instrument", "EUR/USD");
        String period = pa.get("period", "M1");
        String side = pa.get("side", "BID");
        boolean pretty = pa.hasFlag("pretty");

        Long from = pa.getLong("from", (Long) null);
        Long to = pa.getLong("to", (Long) null);
        long minutes = pa.getLong("minutes", 60L);

        if (to == null) to = Instant.now().toEpochMilli();
        if (from == null) from = Instant.now().minus(minutes, ChronoUnit.MINUTES).toEpochMilli();

        String url = rest + "/api/history"
                + "?instrument=" + urlEncode(instrument)
                + "&period=" + urlEncode(period)
                + "&from=" + from
                + "&to=" + to
                + "&side=" + urlEncode(side);

        httpRequest("GET", url, null, pretty);
    }

    // -------------------- orderbook --------------------

    private static void cmdOrderBook(String[] args) throws Exception {
        ParsedArgs pa = ParsedArgs.parse(args);

        String rest = pa.get("rest", envOr("JFOREX_REST", "http://localhost:7080"));
        String instrument = pa.get("instrument", null);
        boolean pretty = pa.hasFlag("pretty");

        String url = rest + "/api/orderbook";
        if (instrument != null && !instrument.isBlank()) {
            url += "?instrument=" + urlEncode(instrument);
        }

        httpRequest("GET", url, null, pretty);
    }

    // -------------------- instruments --------------------

    private static void cmdInstruments(String[] args) throws Exception {
        if (args.length == 0 || args[0].isBlank()) {
            throw new CliExit(2,
                    "Uso: instruments <list|set> [opcoes]\n\n" +
                    "Exemplos:\n" +
                    "  instruments list --rest http://localhost:7080\n" +
                    "  instruments set  --rest http://localhost:7080 --list EUR/USD,USD/JPY,BTC/USD\n");
        }
        String action = args[0].toLowerCase();
        ParsedArgs pa = ParsedArgs.parse(slice(args, 1));

        String rest = pa.get("rest", envOr("JFOREX_REST", "http://localhost:7080"));
        boolean pretty = pa.hasFlag("pretty");

        if ("list".equals(action)) {
            httpRequest("GET", rest + "/api/instruments", null, pretty);
            return;
        }

        if ("set".equals(action) || "update".equals(action)) {
            String list = pa.get("list", null);
            if (list == null || list.isBlank()) {
                throw new CliExit(2, "Faltou --list. Ex.: instruments set --list EUR/USD,USD/JPY,BTC/USD");
            }
            httpRequest("POST", rest + "/api/instruments?list=" + urlEncode(list), "", pretty);
            return;
        }

        throw new CliExit(2, "Acao desconhecida: " + action + " (use list ou set)");
    }

    // -------------------- websocket --------------------

    private static void cmdWebSocket(String[] args) throws Exception {
        ParsedArgs pa = ParsedArgs.parse(args);

        String wsBase = pa.get("ws", envOr("JFOREX_WS", "ws://localhost:7081/ticker"));
        boolean pretty = pa.hasFlag("pretty");

        // Parametrizacao no estilo do payload.md
        String topOfBook = pa.get("topOfBook", pa.get("top", null));
        String instIDs = pa.get("instIDs", pa.get("instruments", null));

        String url = wsBase;
        String query = buildQuery(Map.of(
                "topOfBook", topOfBook,
                "instIDs", instIDs
        ));
        if (!query.isEmpty()) {
            url += (wsBase.contains("?") ? "&" : "?") + query;
        }

        long durationSec = pa.getLong("duration", 0L);
        int count = (int) pa.getLong("count", 0L);

        System.out.println("CONNECT " + url);

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();

        AtomicInteger msgCount = new AtomicInteger(0);
        CountDownLatch done = new CountDownLatch(1);

        WebSocket.Listener listener = new WebSocket.Listener() {
            private final StringBuilder partial = new StringBuilder();

            @Override
            public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                partial.append(data);
                if (last) {
                    String text = partial.toString();
                    partial.setLength(0);

                    int n = msgCount.incrementAndGet();
                    if (pretty) {
                        System.out.println("#" + n);
                        System.out.println(Json.pretty(text));
                    } else {
                        System.out.println(text);
                    }

                    if (count > 0 && n >= count) {
                        webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "done");
                        done.countDown();
                    }
                }
                webSocket.request(1);
                return null;
            }

            @Override
            public void onError(WebSocket webSocket, Throwable error) {
                System.err.println("WebSocket erro: " + error.getMessage());
                done.countDown();
            }

            @Override
            public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
                System.out.println("WebSocket fechado: " + statusCode + " " + reason);
                done.countDown();
                return null;
            }
        };

        CompletableFuture<WebSocket> wsFuture = client.newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .buildAsync(URI.create(url), listener);

        WebSocket ws = wsFuture.join();
        ws.request(1);

        if (durationSec > 0) {
            done.await(durationSec, TimeUnit.SECONDS);
            try {
                ws.sendClose(WebSocket.NORMAL_CLOSURE, "timeout").join();
            } catch (Exception ignore) {
            }
            done.countDown();
            return;
        }

        // sem duration e sem count: roda indefinidamente
        done.await();
    }

    // -------------------- position (opcional) --------------------

    private static void cmdPosition(String[] args) throws Exception {
        if (args.length == 0 || args[0].isBlank()) {
            throw new CliExit(2,
                    "Uso: position <get|open|edit|close> [opcoes]\n\n" +
                    "Baseado no payload.md (REST).\n\n" +
                    "Exemplos:\n" +
                    "  position get   --rest http://localhost:7080 --clientOrderID ORD_1004\n" +
                    "  position open  --rest http://localhost:7080 --instID AUDJPY --clientOrderID ORD_1004 --orderSide Buy --orderType Market --quantity 10000\n" +
                    "  position edit  --rest http://localhost:7080 --clientOrderID ORD_1005 --takeProfitPips 10 --stopLossPips 5\n" +
                    "  position close --rest http://localhost:7080 --clientOrderID ORD_1005\n\n" +
                    "Se a sua API usar endpoints diferentes, ajuste com --path (default: /api/v1/position).\n");
        }
        String action = args[0].toLowerCase();
        ParsedArgs pa = ParsedArgs.parse(slice(args, 1));

        String rest = pa.get("rest", envOr("JFOREX_REST", "http://localhost:7080"));
        String path = pa.get("path", "/api/v1/position");
        boolean pretty = pa.hasFlag("pretty");

        // parametros comuns
        String clientOrderID = pa.get("clientOrderID", pa.get("clientOrderId", null));
        String dukasOrderID = pa.get("dukasOrderID", null);

        if ("get".equals(action)) {
            Map<String, String> q = new HashMap<>();
            if (clientOrderID != null) q.put("clientOrderID", clientOrderID);
            if (dukasOrderID != null) q.put("dukasOrderID", dukasOrderID);
            if (q.isEmpty()) throw new CliExit(2, "Informe --clientOrderID ou --dukasOrderID");
            httpRequest("GET", rest + path + "?" + buildQuery(q), null, pretty);
            return;
        }

        if ("open".equals(action)) {
            String instID = required(pa, "instID");
            String orderSide = required(pa, "orderSide");
            String orderType = required(pa, "orderType");
            String quantity = required(pa, "quantity");
            if (clientOrderID == null) clientOrderID = required(pa, "clientOrderID");

            Map<String, String> q = new HashMap<>();
            q.put("instID", instID);
            q.put("clientOrderID", clientOrderID);
            q.put("orderSide", orderSide);
            q.put("orderType", orderType);
            q.put("quantity", quantity);
            if (pa.get("price", null) != null) q.put("price", pa.get("price", null));
            if (pa.get("slippage", null) != null) q.put("slippage", pa.get("slippage", null));

            httpRequest("POST", rest + path + "?" + buildQuery(q), "", pretty);
            return;
        }

        if ("edit".equals(action)) {
            if (clientOrderID == null && dukasOrderID == null) {
                throw new CliExit(2, "Informe --clientOrderID ou --dukasOrderID");
            }

            Map<String, String> q = new HashMap<>();
            if (clientOrderID != null) q.put("clientOrderID", clientOrderID);
            if (dukasOrderID != null) q.put("dukasOrderID", dukasOrderID);
            if (pa.get("takeProfitPips", null) != null) q.put("takeProfitPips", pa.get("takeProfitPips", null));
            if (pa.get("stopLossPips", null) != null) q.put("stopLossPips", pa.get("stopLossPips", null));

            httpRequest("PUT", rest + path + "?" + buildQuery(q), "", pretty);
            return;
        }

        if ("close".equals(action) || "delete".equals(action)) {
            if (clientOrderID == null && dukasOrderID == null) {
                throw new CliExit(2, "Informe --clientOrderID ou --dukasOrderID");
            }
            Map<String, String> q = new HashMap<>();
            if (clientOrderID != null) q.put("clientOrderID", clientOrderID);
            if (dukasOrderID != null) q.put("dukasOrderID", dukasOrderID);

            httpRequest("DELETE", rest + path + "?" + buildQuery(q), null, pretty);
            return;
        }

        throw new CliExit(2, "Acao desconhecida: " + action + " (use get|open|edit|close)");
    }

    // -------------------- HTTP helpers --------------------

    private static void httpRequest(String method, String url, String body, boolean pretty) throws IOException, InterruptedException {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();

        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("Accept", "application/json");

        switch (method.toUpperCase()) {
            case "GET":
                b.GET();
                break;
            case "POST":
                b.POST(body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
                break;
            case "PUT":
                b.PUT(body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
                break;
            case "DELETE":
                b.DELETE();
                break;
            default:
                b.method(method.toUpperCase(), body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        }

        HttpRequest req = b.build();
        System.out.println(method.toUpperCase() + " " + url);
        HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());
        System.out.println("HTTP " + res.statusCode());

        String out = res.body() == null ? "" : res.body();
        if (pretty) System.out.println(Json.pretty(out));
        else System.out.println(out);

        if (res.statusCode() >= 400) {
            // sinaliza erro para scripts
            throw new CliExit(3, null);
        }
    }

    // -------------------- utilities --------------------

    private static String required(ParsedArgs pa, String key) {
        String v = pa.get(key, null);
        if (v == null || v.isBlank()) throw new CliExit(2, "Faltou --" + key);
        return v;
    }

    private static String envOr(String key, String def) {
        String v = System.getenv(key);
        if (v != null && !v.isBlank()) return v;
        return def;
    }

    private static String[] slice(String[] arr, int start) {
        if (arr == null || start >= arr.length) return new String[0];
        String[] out = new String[arr.length - start];
        System.arraycopy(arr, start, out, 0, out.length);
        return out;
    }

    private static String urlEncode(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private static String buildQuery(Map<String, String> params) {
        if (params == null || params.isEmpty()) return "";
        StringJoiner sj = new StringJoiner("&");
        for (Map.Entry<String, String> e : params.entrySet()) {
            String k = e.getKey();
            String v = e.getValue();
            if (k == null || k.isBlank()) continue;
            if (v == null || v.isBlank()) continue;
            sj.add(urlEncode(k) + "=" + urlEncode(v));
        }
        return sj.toString();
    }

    private static void usage(int exitCode) {
        String txt =
                "JForexCtl - CLI (HTTP + WebSocket)\n\n" +
                "Uso:\n" +
                "  jforexctl <comando> [opcoes]\n\n" +
                "Comandos:\n" +
                "  history               GET /api/history\n" +
                "  orderbook             GET /api/orderbook\n" +
                "  instruments list|set  GET/POST /api/instruments\n" +
                "  ws                    Conecta em ws://.../ticker e imprime payloads\n" +
                "  position ...          (opcional) baseado no payload.md\n" +
                "  help\n\n" +
                "Opcoes comuns:\n" +
                "  --rest <url>   Base REST (default: $JFOREX_REST ou http://localhost:7080)\n" +
                "  --ws <url>     Base WS  (default: $JFOREX_WS   ou ws://localhost:7081/ticker)\n" +
                "  --pretty       Pretty-print JSON\n\n" +
                "Exemplos:\n" +
                "  jforexctl history --rest http://localhost:7080 --instrument EUR/USD --period M1 --minutes 60 --pretty\n" +
                "  jforexctl orderbook --rest http://localhost:7080 --instrument USD/JPY --pretty\n" +
                "  jforexctl instruments list --rest http://localhost:7080\n" +
                "  jforexctl instruments set --rest http://localhost:7080 --list EUR/USD,USD/JPY,BTC/USD\n" +
                "  jforexctl ws --ws ws://localhost:7081/ticker --topOfBook true --instIDs EURUSD,USDJPY --pretty\n\n" +
                "Dica: se o seu servidor Spring Boot estiver na porta 8080,\n" +
                "  use --rest http://localhost:8080 e --ws ws://localhost:8080/ticker\n";

        if (exitCode == 0) System.out.println(txt);
        else System.err.println(txt);
        System.exit(exitCode);
    }

    // -------------------- internal types --------------------

    private static final class CliExit extends RuntimeException {
        final int code;
        final String message;

        CliExit(int code, String message) {
            this.code = code;
            this.message = message;
        }
    }

    private static final class ParsedArgs {
        private final Map<String, String> kv;
        private final Set<String> flags;
        private final List<String> positionals;

        private ParsedArgs(Map<String, String> kv, Set<String> flags, List<String> positionals) {
            this.kv = kv;
            this.flags = flags;
            this.positionals = positionals;
        }

        static ParsedArgs parse(String[] args) {
            if (args == null || args.length == 0) {
                return new ParsedArgs(Collections.emptyMap(), Collections.emptySet(), Collections.emptyList());
            }

            Map<String, String> kv = new HashMap<>();
            Set<String> flags = new HashSet<>();
            List<String> pos = new ArrayList<>();

            for (int i = 0; i < args.length; i++) {
                String a = args[i];
                if (a == null) continue;
                a = a.trim();
                if (a.isEmpty()) continue;

                if (a.startsWith("--")) {
                    String raw = a.substring(2);

                    // suporte --k=v
                    if (raw.contains("=")) {
                        String[] parts = raw.split("=", 2);
                        String k = parts[0];
                        String v = parts.length > 1 ? parts[1] : "";
                        if (!k.isBlank()) kv.put(k, v);
                        continue;
                    }

                    // flag ou key-value
                    String key = raw;
                    if (i + 1 < args.length) {
                        String next = args[i + 1];
                        if (next != null && !next.startsWith("--")) {
                            kv.put(key, next);
                            i++;
                            continue;
                        }
                    }
                    flags.add(key);
                } else {
                    pos.add(a);
                }
            }

            return new ParsedArgs(kv, flags, pos);
        }

        String get(String key, String def) {
            String v = kv.get(key);
            if (v == null || v.isBlank()) return def;
            return v;
        }

        long getLong(String key, long def) {
            String v = kv.get(key);
            if (v == null || v.isBlank()) return def;
            try {
                return Long.parseLong(v);
            } catch (NumberFormatException e) {
                throw new CliExit(2, "Valor invalido para --" + key + ": " + v);
            }
        }

        Long getLong(String key, Long def) {
            String v = kv.get(key);
            if (v == null || v.isBlank()) return def;
            try {
                return Long.parseLong(v);
            } catch (NumberFormatException e) {
                throw new CliExit(2, "Valor invalido para --" + key + ": " + v);
            }
        }

        boolean hasFlag(String flag) {
            return flags.contains(flag);
        }

        @SuppressWarnings("unused")
        List<String> positionals() {
            return positionals;
        }
    }

    /**
     * Pretty printer simples para JSON (sem dependencias externas).
     * Nao valida JSON; apenas tenta formatar por chaves, colchetes e aspas.
     */
    private static final class Json {
        static String pretty(String s) {
            if (s == null) return "";
            String in = s.trim();
            if (in.isEmpty()) return "";

            StringBuilder out = new StringBuilder(in.length() + 64);
            int indent = 0;
            boolean inString = false;
            boolean escaped = false;

            for (int i = 0; i < in.length(); i++) {
                char c = in.charAt(i);

                if (inString) {
                    out.append(c);
                    if (escaped) {
                        escaped = false;
                    } else if (c == '\\') {
                        escaped = true;
                    } else if (c == '"') {
                        inString = false;
                    }
                    continue;
                }

                switch (c) {
                    case '"':
                        inString = true;
                        out.append(c);
                        break;
                    case '{':
                    case '[':
                        out.append(c).append('\n');
                        indent++;
                        indent(out, indent);
                        break;
                    case '}':
                    case ']':
                        out.append('\n');
                        indent = Math.max(0, indent - 1);
                        indent(out, indent);
                        out.append(c);
                        break;
                    case ',':
                        out.append(c).append('\n');
                        indent(out, indent);
                        break;
                    case ':':
                        out.append(c).append(' ');
                        break;
                    default:
                        if (!Character.isWhitespace(c)) out.append(c);
                }
            }

            return out.toString();
        }

        private static void indent(StringBuilder sb, int indent) {
            for (int i = 0; i < indent; i++) sb.append("  ");
        }
    }
}
