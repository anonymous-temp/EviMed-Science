# EviMed 医学证据检索 API

版本：V1.0

## 接口

- Base URL：`https://www.evimed.com/api-evimed/medicine-api/ai-api`
- 指南检索：`POST /review/api/guide`

## 鉴权

API Key 必须由服务端密钥管理系统或本机环境变量提供，禁止写入源码、接口文档、前端、
日志或提交到版本库。

```bash
export EVIMED_API_KEY='replace-with-your-key'
curl -X POST "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/guide" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${EVIMED_API_KEY}" \
  -d '{
    "query": "特应性皮炎",
    "count": 10,
    "startYear": 2022,
    "publishers": ["NCCN"]
  }'
```

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | 是 | 自然语言检索词 |
| `count` | integer | 否 | 返回数量，默认 10、上限 100 |
| `startYear` | integer | 否 | 起始发表年份 |
| `endYear` | integer | 否 | 截止发表年份 |
| `publishers` | string[] | 否 | 发布机构过滤 |
| `language` | string | 否 | `zh` 或 `en` |

## 响应与错误

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "total": 1,
    "list": []
  }
}
```

`401` 表示密钥缺失或无效，`403` 表示账户不可用，`429` 表示超过频率限制，`500` 表示
服务端异常。响应中的指南内容必须保留来源标识，科研结论应回溯原始证据。
