package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.feign.AISearchFeign;
import com.sentum.evidencecomprehensive.opcode.SearchFormula;
import com.sentum.evidencecomprehensive.pojo.dto.LGYearDto;
import com.sentum.evidencecomprehensive.pojo.dto.*;
import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.pojo.vo.LiteratureGuideVo;
import com.sentum.evidencecomprehensive.service.RetrievalService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.commonmark.node.Node;
import org.commonmark.parser.Parser;
import org.commonmark.renderer.html.HtmlRenderer;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;

@Slf4j
@Api(tags = "检索页面相关API")
@RestController
@RequestMapping("/evidence-api/retrieval-api")
public class RetrievalController {
    
    @Autowired
    private RetrievalService retrievalService;
    @Autowired
    private AISearchFeign aiSearchFeign;

    @GetMapping("/per-info")
    public DataResult personal(HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
            return DataResult.data(retrievalService.personal(token, userId));
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
    }

    @ApiOperation(value = "查询 Guide Hta Cde 纳入数量", notes = "search")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = " 课题 id", required = true)
    })
    @GetMapping("/search")
    public DataResult search(String id, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(retrievalService.search(id, userId));
    }

    @ApiOperation(value = "拼接检索式", notes = "retrieval")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "condition", value = "连接条件", required = false),
            @ApiImplicitParam(name = "originalWord", value = "被拼接的原始检索式", required = false),
            @ApiImplicitParam(name = "range", value = "检索条件", required = true),
            @ApiImplicitParam(name = "word", value = "拼接检索式", required = true)
    })
    @GetMapping("/mode")
    public DataResult SearchMode(String condition, String originalWord, String range, String word) {
        return DataResult.data(retrievalService.searchMode(condition, originalWord, range, word));
    }
    
    @ApiOperation(value = "综合检索页面--流式", notes = "/questions/answers-stream")
    @ApiImplicitParam(name = "小灵接口", value = "小灵接口", required = true)
    @GetMapping("/questions/answers-stream")
    public void outlineStream(String question, Integer startYear, Integer endYear, HttpServletResponse response) {
        response.setContentType("text/event-stream");
        response.setCharacterEncoding("UTF-8");
        response.setHeader("Cache-Control","no-cache");
        
        feign.Response stream = aiSearchFeign.stream(question, startYear, endYear);
        feign.Response.Body body = stream.body();

        StringBuilder stringBuilder = new StringBuilder();

        try (InputStream inputStream = body.asInputStream();
             BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
//                gptAiUtils.write("", line, response, 2);
                if (line.contains("[START]")) continue;
                if (line.contains("[END]")) continue;
                if (line.contains("|")) continue;
                if (line.contains("<span")) {
                    int i = line.indexOf("<span");
                    int i1 = line.lastIndexOf("</span>");
                    String temp = line;
                    String end = temp.substring(i1 + 7);
                    String begin = temp.substring(0, i);
                    line =  begin + end;
                }
                Parser parser = Parser.builder().build();
                Node document = parser.parse(line);

                // 渲染为 HTML
                HtmlRenderer renderer = HtmlRenderer.builder().build();
                String htmlContent = renderer.render(document);
                stringBuilder.append(htmlContent);
                
                System.out.println(line);
                System.out.println("---------------------");
            }
        } catch (IOException e) {
           log.error(e.getMessage(), e);
        }

        System.out.println(stringBuilder.toString());
    }
    

    @ApiOperation(value = "文献指南编辑接口", notes = "edit-LG")
    @PostMapping("/edit-LG")
    public DataResult editLiteratureGuide(@RequestBody LiteratureGuideVo literatureGuideVo, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        retrievalService.editLiteratureGuide(literatureGuideVo, userId);
        return DataResult.ok();
    }
    
    @ApiOperation(value = "获取首次纳入的文献指南", notes = "acquire-LG")
    @GetMapping("/acquire-LG")
    @ApiImplicitParam(name = "id", value = "课题id")
    public DataResult acquireLiteratureGuide(String id, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(retrievalService.acquireLiteratureGuide(id, userId));
    }
    

    @ApiOperation(value = "获取文献指南纳入情况状态", notes = "acquire-status")
    @GetMapping("/acquire-status")
    @ApiImplicitParam(name = "id", value = "课题id")
    public DataResult acquireStatus(String id, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(retrievalService.acquireStatus(id, userId));
    }

    @ApiOperation(value = "确定报告生成文献指南的时间范围", notes = "confirm-year")
    @PostMapping("/confirm-year")
    public DataResult confirmLGYear(@RequestBody LGYearDto lgYearDto) {
        retrievalService.confirmLGYear(lgYearDto);
        return DataResult.ok();
    }

    @ApiOperation(value = "获取文献分类列表", notes = "type-list")
    @GetMapping("/type-list")
    public DataResult typeList(){
        return DataResult.data(retrievalService.typeList());
    }

    @ApiOperation(value = "循证综合评价同义词", notes = "synonym")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "word", value = "检索词", required = true),
            @ApiImplicitParam(name = "range", value = "1-药品；2-疾病；3-参比药物；4-结局指标", required = true),
            @ApiImplicitParam(name = "isTranslate", value = "是否需要翻译 1翻译 2不翻译", required = true)
    })
    @GetMapping("/synonym")
    public DataResult synonym(String word, Integer range, Integer isTranslate){
        return DataResult.data(retrievalService.synonym(word, range, isTranslate));
    }

    @ApiOperation(value = "同义词反馈", notes = "synonym_feedback")
    @PostMapping("/synonym_feedback")
    public DataResult synonymFeedback(@RequestBody SynonymFeedbackDto synonymFeedbackDto, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        Boolean aBoolean = retrievalService.synonymFeedback(synonymFeedbackDto, userId);
        if (aBoolean){
            return DataResult.ok();
        }
        return DataResult.error("反馈失败！！！");
    }

    @ApiOperation(value = "药品输入框，返回药品名称列表name，剂型列表dosageForm", notes = "synonym")
    @ApiImplicitParam(name = "drug", value = "用户输入药品名称", required = true)
    @GetMapping("/drug-info")
    public DataResult drugInfo(String drug){
        return DataResult.data(retrievalService.drugInfo(drug));
    }

    @ApiOperation(value = "获得疾病列表", notes = "disease")
    @PostMapping("/disease")
    public DataResult disease(@RequestBody DrugDto drugDto){
        return DataResult.data(retrievalService.disease(drugDto));
    }

    @ApiOperation(value = "icd10疾病列表", notes = "icd10")
    @PostMapping("/icd10")
    public DataResult icd10(@RequestBody DrugDto drugDto){
        return DataResult.data(retrievalService.icd10(drugDto));
    }

    @ApiOperation(value = "参比药物", notes = "reference-drug")
    @PostMapping("/reference-drug")
    public DataResult referenceDrug(@RequestBody DrugDto drugDto){
        return DataResult.data(retrievalService.referenceDrug(drugDto));
    }

    @ApiOperation(value = "结局指标", notes = "outcome")
    @PostMapping("/outcome")
    public DataResult outcome(@RequestBody OutcomeDto outcomeDto){
        return DataResult.data(retrievalService.outcome(outcomeDto));
    }

    @ApiOperation(value = "保存用户检索条件", notes = "save-condition")
    @PostMapping("/save-condition")
    public DataResult saveCondition(@RequestBody ConditionDto conditionDto, HttpServletRequest request, HttpServletResponse response){
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(retrievalService.saveCondition(conditionDto, userId, request));
    }

    @ApiOperation(value = "回显用户的检索信息", notes = "echo")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/echo")
    public DataResult echo(String id) {
        return DataResult.data(retrievalService.echo(id));
    }

    @ApiOperation(value = "检索式检索", notes = "retrieval")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "query", value = "检索式", required = true),
            @ApiImplicitParam(name = "type", value = "1文献，2指南，3说明书，4临床试验", required = true)
    })
    @GetMapping("/retrieval")
    public String retrieval(String query, Integer type) {
        SearchFormula searchFormula = new SearchFormula();
        String name = "";
        switch (type) {
            case 1:
                name = "文献";
                break;
            case 2:
                name = "指南";
                break;
            case 3:
                name = "说明书";
                break;
            case 4:
                name = "临床试验";
                break;
            default:
                break;
        }
        log.info("[{}]-[{}]", name, query);
        BoolQueryBuilder execute = searchFormula.execute(query, type, 1, 0);
        return execute.toString();
    }

    @ApiOperation(value = "检索式检索", notes = "retrieval")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "query", value = "检索式", required = true),
            @ApiImplicitParam(name = "type", value = "1文献，2指南，3说明书，4临床试验", required = true)
    })
    @PostMapping("/large-retrieval")
    public String largeRetrieval(@RequestBody MultiValueMap<String,String> map) {
        SearchFormula searchFormula = new SearchFormula();
        String mapType = map.get("type").get(0);
        int type = 1;
        if (StringUtils.isNotBlank(mapType)) {
            type = Integer.parseInt(mapType);
        }
        String query = map.get("query").get(0);
        String name = "";
        switch (type) {
            case 1:
                name = "文献";
                break;
            case 2:
                name = "指南";
                break;
            case 3:
                name = "说明书";
                break;
            case 4:
                name = "临床试验";
                break;
            default:
                break;
        }
        log.info("[{}]-[{}]", name, query);
        BoolQueryBuilder execute = searchFormula.execute(query, type, 1, 0);
        return execute.toString();
    }
}
