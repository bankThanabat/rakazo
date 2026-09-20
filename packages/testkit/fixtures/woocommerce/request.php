<?php
// Test-only HTTP transport within the isolated store container. No host ports.
$request = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
if (!str_starts_with($request['path'], '/wp-json/')) {
    throw new RuntimeException('Only fixture REST routes are allowed');
}
$curl = curl_init('http://127.0.0.1' . $request['path']);
$headers = [];
curl_setopt_array($curl, [
    CURLOPT_CUSTOMREQUEST => $request['method'],
    CURLOPT_HTTPHEADER => $request['headers'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_TIMEOUT => 30,
    CURLOPT_HEADERFUNCTION => function ($curl, $line) use (&$headers) {
        $parts = explode(':', trim($line), 2);
        if (count($parts) === 2) $headers[] = [$parts[0], trim($parts[1])];
        return strlen($line);
    },
]);
if ($request['body'] !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, $request['body']);
$body = curl_exec($curl);
if ($body === false) throw new RuntimeException('Fixture HTTP request failed');
echo json_encode(['status' => curl_getinfo($curl, CURLINFO_HTTP_CODE), 'headers' => $headers, 'body' => $body], JSON_THROW_ON_ERROR);
