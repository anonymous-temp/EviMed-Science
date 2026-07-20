package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.service.SuperManualReportService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * 超说明书报告页面相关API
 * @author zgm
 */
@Slf4j
@Api(tags = "超说明书报告页面相关API")
@RestController
@RequestMapping("/evidence-api-based/super-manual-api")
public class SuperManualReportController {
    @Autowired
    private SuperManualReportService superManualReportService;

    @ApiOperation(value = "生成超说明书报告", notes = "create")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/create")
    public DataResult create(@RequestParam("id") String id, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(superManualReportService.create(id, userId, request));
    }

    @ApiOperation(value = "查看超说明书报告", notes = "show")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/show")
    public DataResult show(String id) {
        return DataResult.data(superManualReportService.show(id));
    }

    @ApiOperation(value = "下载超说明书报告", notes = "download")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/download")
    public void download(String id, HttpServletResponse response) {
        superManualReportService.download(id, response);
    }
}
