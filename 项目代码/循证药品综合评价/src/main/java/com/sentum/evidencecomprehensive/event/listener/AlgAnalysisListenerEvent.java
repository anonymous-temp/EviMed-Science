package com.sentum.evidencecomprehensive.event.listener;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateTime;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.jcraft.jsch.*;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.mongo.MongoLiterature;
import com.sentum.evidencecomprehensive.domain.es.PaperIndex;
import com.sentum.evidencecomprehensive.domain.mongo.upload.PdfAnalysis;
import com.sentum.evidencecomprehensive.event.AlgAnalysisEvent;
import com.sentum.evidencecomprehensive.event.bo.AlgAnalysisBo;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.service.PdfEditResultService;
import com.sentum.evidencecomprehensive.service.PdfEditService;
import com.sentum.evidencecomprehensive.utils.operateyl.HttpClientUtils;
import com.sentum.evidencecomprehensive.utils.ReleaseMongoUtil;
import com.sentum.evidencecomprehensive.utils.operateyl.SftpUtils;
import lombok.extern.slf4j.Slf4j;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.event.EventListener;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Component;

import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URISyntaxException;
import java.util.*;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * @Description:  算法解析图片四角坐标事件监听处理类
 */
@Slf4j
@Component
public class AlgAnalysisListenerEvent {

    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private PdfEditService pdfEditService;
    @Autowired
    private PdfEditResultService pdfEditResultService;
    @Autowired
    private FineScreenFeign fineScreenFeign;

    @Value("${sftp.host}")
    private String sftpHost;
    @Value("${sftp.port}")
    private Integer sftpPort;
    @Value("${sftp.userName}")
    private String sftpUserName;
    @Value("${sftp.password}")
    private String sftpPassword;
    @Value("${pdf.edit.analysis}")
    private String pdfEditAnalysis;
    @Value("${localPath.pdf.to.image}")
    private String pdfToImagePath;

    // 定义一个ThreadLocal来存储每个线程的InputStream
    private static final ThreadLocal<InputStream> threadLocalInputStream = new ThreadLocal<>();
    
    // @Async
//    @UploadPdfDistributeLock(scene = "UPLOAD_PDF", keyExpression = "#event.algAnalysisBo.id", waitTime = 0)
    @EventListener(classes = AlgAnalysisEvent.class)
    public void algAnalysis(AlgAnalysisEvent event) {
        Date begin = new Date();

        AlgAnalysisBo algAnalysisBo = event.getAlgAnalysisBo();
        String paperId = algAnalysisBo.getId();
        String questionId = algAnalysisBo.getQuestionId();
        Long userId = algAnalysisBo.getUserId();
        String studyType = algAnalysisBo.getStudyType();
        String pdfFilePath = algAnalysisBo.getPdfFilePath();

        if (StrUtil.isBlank(paperId)) {
            return;
        }

        PdfAnalysis pdfAnalysis = new PdfAnalysis();
        pdfAnalysis.setPaperId(paperId);
        pdfAnalysis.setUserId(userId);
        pdfAnalysis.setQuestionId(questionId);
        
        PdfAnalysis mongo = mongoTemplate.findOne(
                new Query(Criteria.where("paperId").is(paperId)
                        .and("userId").is(userId)
                        .and("questionId").is(questionId)
                        .and("paperType").is(studyType)), PdfAnalysis.class);
        if (Objects.nonNull(mongo)) {
            pdfAnalysis = mongo;
        }
        
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        boolQueryBuilder.must().add(QueryBuilders.idsQuery().addIds(paperId));
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
        SearchHit<PaperIndex> paperSelect = elasticsearchRestTemplate.searchOne(nativeSearchQuery, PaperIndex.class);
        if (paperSelect == null){
            PdfAnalysis mongo_inner = mongoTemplate.findOne(
                    new Query(Criteria.where("paperId").is(paperId)
                            .and("userId").is(userId)
                            .and("questionId").is(questionId)
                            .and("paperType").is(studyType)), PdfAnalysis.class);
            if (Objects.nonNull(mongo_inner)) {
                pdfAnalysis = mongo_inner;
                pdfAnalysis.setAlgSuccess(false);
                pdfAnalysis.setFailureReason("es 查无此篇文献，文献 id：" + paperId);
                log.info("es 查无此篇文献，文献 id：{}", paperId);
            }
        }


        MongoLiterature mongoLiterature = fineScreenFeign.paper(paperId);
//        MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("_id").is(paperId)), MongoLiterature.class, "mongo_literature_" + Math.abs(paperId.hashCode()) % 10);
        if (Objects.nonNull(paperSelect) && mongoLiterature != null) {
            String language = mongoLiterature.getLanguage();

            if ("zh".equals(language)) {
                language = "ch"; // 算法接口中文接收的是ch
            }

            // mongo中 文献类型
            List<Integer> lastNewType = mongoLiterature.getLastNewType();
            // 直接截断，不消耗服务资源
            log.info("进入算法分析之前，当前前端传过来的文献类型是{}", studyType);
//            if (CollUtil.isNotEmpty(lastNewType) && lastNewType.size() > 1 && "12".equals(studyType)) { // 多标签的情况下包含经济类型 不给予分析
//                pdfAnalysis.setAlgSuccess(false);
//                pdfAnalysis.setFailureReason("多标签的情况下包含经济类型 不给予分析！！！");
//                mongoTemplate.save(pdfAnalysis);
//                log.info("进入算法分析之前，多标签的情况下包含经济类型 不给予分析");
//                return;
//            }

            // 0 Meta  2 RCT  12 经济类 目前只支持这 3 种类型
            List<String> studyTypes = Arrays.asList("0", "2", "12");
            // 只有0，3，12的文献类型pdf才会被解析
            log.info("进入算法分析之前，----- 分析的类型是,  前端传过来的{}, 文献的类型（数据库中的）是{}", studyType, lastNewType);
            if (StrUtil.isNotBlank(language)
                    && CollUtil.isNotEmpty(lastNewType) 
                    && lastNewType.contains(Integer.parseInt(studyType)) 
                    && studyTypes.contains(studyType)) {
                
                // meta rct economy 的参数会不同
                Map<String, String> paramMap = new HashMap<>();
                paramMap.put("pdf_path", pdfFilePath);
                paramMap.put("lang", language);
                paramMap.put("study_type", studyType);
                paramMap.put("paper_id", paperId);
                
                // meta类型需要的参数
                if ("0".equals(studyType)) {
                    if (mongoLiterature.getBelong().contains("Cochrane")) {
                        paramMap.put("journal_is_cochrane", "1");
                    } else {
                        paramMap.put("journal_is_cochrane", "0");
                    }
                }
                
                // 经济类型需要的参数
                if ("12".equals(studyType)) { // 经济类 需要 tilte 和 summary
                    paramMap.put("title", "");
                    if (StrUtil.isNotBlank(mongoLiterature.getTitle())) {
                        paramMap.put("title", mongoLiterature.getTitle());
                    }
                    paramMap.put("abstract", "");
                    if (StrUtil.isNotBlank(mongoLiterature.getSummary())) {
                        paramMap.put("abstract", mongoLiterature.getSummary());
                    }
                }
                
                // 开始进行算法解析 时间计时
                DateTime dateTime = new DateTime();
                JSONObject data = new JSONObject();
                try {
                    Date begin1 = new Date();
                    log.info("alg 进行算法解析, 文献 id{}", paperId);
                    pdfAnalysis.setStatus(3);
                    mongoTemplate.save(pdfAnalysis);
                    
                    String params = JSONUtil.toJsonStr(paramMap);
                    data = JSON.parseObject(HttpClientUtils.sendGetDataByJson(pdfEditAnalysis, params), JSONObject.class);
                    log.info("alg 算法解析完成,文献 id{}，解析用时{}, 解析内容{} ", paperId, new Date().getTime() - begin1.getTime(), JSON.toJSONString(data));
                }catch (IOException | URISyntaxException e) {
                    log.info("alg 调用 http 算法接口失败！！！");
                    log.error(e.getMessage(), e);
                    pdfAnalysis.setAlgSuccess(false);
                    pdfAnalysis.setStatus(4);
                    pdfAnalysis.setFailureReason("解析失败！调用 http get 接口失败！");
                    mongoTemplate.save(pdfAnalysis);
                }

                // 有数据进行解析
                if (Objects.nonNull(data)
                        && "1".equals(data.getString("result"))  // 1标识成功
                        && CollUtil.isNotEmpty(data.getJSONArray("result_data"))) {
                    log.info("开始处理算法解析后的结果，将图片标记四角坐标");
//                    analysis(data, pdfAnalysis, studyType);
//                        log.info("算法解析结果处理完成");
                    pdfAnalysis.setAlgSuccess(true);
                    pdfAnalysis.setFailureReason("解析处理完成！");
                    pdfAnalysis.setData(data);
                    mongoTemplate.save(pdfAnalysis);
                    log.info("文献{}, 解析处理完成！", paperId);
                } else {
                    if (Objects.isNull(data)) {
                        log.info("alg 解析失败, data 为 {}", JSON.toJSONString(data));
                        
                    } else if (!"1".equals(data.getString("result"))) {
                        log.info("alg 解析失败, result 为 {}", data.getString("result"));
                    } else if (CollUtil.isEmpty(data.getJSONArray("result_data"))) {
                        log.info("alg 解析失败, result_data 为 {}", data.getJSONArray("result_data"));
                    }
                    pdfAnalysis.setFailureReason("alg 算法解析失败！！！");
                    pdfAnalysis.setStatus(4);
                    pdfAnalysis.setAlgSuccess(false);
                    mongoTemplate.save(pdfAnalysis);
                }
                log.info("调用时长{}", new DateTime().getTime() - dateTime.getTime());
            } else {
                if (StrUtil.isBlank(language)) {
                    pdfAnalysis.setFailureReason("文献 language 不能为空！");
                }
                if (CollUtil.isEmpty(lastNewType)) {
                    pdfAnalysis.setFailureReason("文献 类型 不能为空！");
                }
                pdfAnalysis.setAlgSuccess(false);
                pdfAnalysis.setStatus(4);
                mongoTemplate.save(pdfAnalysis);
            }
        }
        log.info("文献 id {}, 算法解析完成 + 画完四角坐标时间{}", paperId, new Date().getTime() - begin.getTime());
    }

    
    
    
    
    
    
    
    
    
    
    
    private void analysis(JSONObject data, PdfAnalysis pdfAnalysis, String studyType) {
        if (Objects.nonNull(pdfAnalysis.getSuccess()) && !pdfAnalysis.getSuccess()) return; // 如果图片都没转换成功直接 pass
        Session jschSession = null;
        try {
            JSch jsch = new JSch();
            jschSession = jsch.getSession(sftpUserName, sftpHost, sftpPort);
            // 通过密码的方式登录认证
            jschSession.setPassword(sftpPassword);
            Properties properties = new Properties();
            properties.put("StrictHostKeyChecking", "no");
            jschSession.setConfig(properties);
            jschSession.connect(Constants.SESSION_TIMEOUT);
            // 建立sftp文件传输管道
            Channel sftp = jschSession.openChannel("sftp");
            sftp.connect(Constants.CHANNEL_TIMEOUT);
            ChannelSftp channelSftp = (ChannelSftp) sftp;

            // 算法解析的数据
            ExecutorService executorService = Executors.newFixedThreadPool(8);
            JSONArray result_data = data.getJSONArray("result_data");
            for (Object result_datum : result_data) {
                Runnable runnable = () -> {
                    JSONObject model = JSON.parseObject(JSON.toJSONString(result_datum), JSONObject.class);
                    // 每个标准 modeId 对应的会有多个 四角坐标的解析结果
                    JSONArray reference = model.getJSONArray("reference");
                    String id = model.getString("id"); // 文献 id
                    if (Objects.nonNull(reference) && CollUtil.isNotEmpty(reference)) {
                        for (Object o : reference) {
                            JSONObject number = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                            JSONArray bbox = number.getJSONArray("bbox");
                            if (StrUtil.isNumeric(number.getString("page"))
                                    && Objects.nonNull(bbox)
                                    && CollUtil.isNotEmpty(bbox)) {
                                try {
                                    Integer page = number.getInteger("page");
                                    drawPicBy4XY(channelSftp, pdfAnalysis, page, bbox, id);
                                } catch (Exception e) {
                                    log.error(e.getMessage(), e);
                                }
                            }
                        }
                    }
                };
                executorService.execute(runnable);
            }
            executorService.shutdown();
            try {
                // 等待所有任务完成，直到超时或者所有任务执行完毕
                // 参数是等待的时间（单位是毫秒），在这里设为0表示无限等待
                boolean terminated = executorService.awaitTermination(Long.MAX_VALUE, TimeUnit.MILLISECONDS);
                if (terminated) {
                    log.info("所有任务已完成，线程池已关闭。");
                } else {
                    log.info("等待超时，但线程池可能仍有任务在执行。");
                }
            } catch (InterruptedException e) {
                // 处理中断异常
                log.info("等待过程中被中断。");
                Thread.currentThread().interrupt(); // 重新设置中断标志
            }

//            while (!executorService.isTerminated()) {
//                try {
//                    Thread.sleep(1);
//                } catch (InterruptedException e) {
//                    log.error(e.getMessage(), e);
//                }
//            }
            channelSftp.exit();
        } catch (JSchException e) {
            log.error(e.getMessage(), e);
        } finally {
            if (jschSession != null) {
                try {
                    jschSession.disconnect();
                } catch (Exception e) {
                    log.warn(e.getMessage(), e);
                }
            }
        }
    }

    private void drawPicBy4XY(ChannelSftp channelSftp, PdfAnalysis pdfAnalysis, Integer page, JSONArray bbox, String id) throws SftpException, IOException {
        // 将图片进行四角坐标标记
        String paperId = pdfAnalysis.getId();
        String type = pdfAnalysis.getType();
        String algFilePath = pdfAnalysis.getAlgFilePath();
        // 四角坐标
        List<Integer> coordinates = JSON.parseObject(JSON.toJSONString(bbox), new TypeReference<List<Integer>>() {});
        // 文件存储服务器地址
        String remoteAlgFilename = algFilePath + Constants.PAD_LEFT_SLASH + paperId + "_" + (page) + "." + type;
        // 远程图片文件 流文件
        // 两人同时上传的时候第二个人会把第一个人的删除  第一个人 获取的时候就是 null  no such file    todo
        try {
            // 在每个线程中获取或创建一个新的InputStream
//            InputStream inputStream = getInputStreamForThread(remoteAlgFilename, channelSftp);
            InputStream inputStream = channelSftp.get(remoteAlgFilename);
            // 读取图片文件，得到BufferedImage对象
            BufferedImage image = ImageIO.read(inputStream);
            // 注意注意 一定要关闭 input 流  否则 你会遇到不知道怎么解决的办法
//            closeInputStreamForThread();
            inputStream.close();
            // 得到Graphics2D 对象
            Graphics2D g2d=(Graphics2D)image.getGraphics();
            // 设置颜色和画笔粗细
            g2d.setColor(Color.RED);
            g2d.setStroke(new BasicStroke(8));
            // 四角坐标
            List<List<Integer>> list = Collections.singletonList(coordinates);
            for (List<Integer> integerList : list) {
                int x = integerList.get(0);
                int y = integerList.get(1);
                int width = integerList.get(2) - x;
                int height = integerList.get(3) - y;
                g2d.draw3DRect(x, y, width, height, false);
            }
            // 四角坐标图片存放路径
            String localPath = pdfToImagePath + paperId + "_" + (page) + "." + type;
            File file = new File(localPath);
            // 将image 流写入文件
            ImageIO.write(image, type, file);
            if (file.exists()) {
                // 也是因为目前如果一个用户上传 pdf 成功之后到算法解析完成之前都是不允许再次上传的 所以不会出现目录不存在的问题，
                // 但是如果支持并发上传就会出现目录不存在问题。
                boolean exists = SftpUtils.directoryExists(channelSftp, algFilePath);
                if (!exists) {
                    SftpUtils.mkdirDirs(algFilePath, channelSftp);
                }
                // 文件服务器图片路径
                channelSftp.put(localPath, remoteAlgFilename);
                boolean delete = FileUtil.del(file);
                if (delete) {
                    log.info("文献{}的id为{}的第{}张算法画四角坐标解析完成并且删除成功", paperId, id, page);
                } else {
                    log.info("本地图片删除失败,路径{}", localPath);
                }
            }
        } catch (SftpException e) {
            log.error(e.getMessage(), e);
            log.error("两人同时上传的时候第二个人会把第一个人的删除  第一个人 获取的时候就是 null  no such file ");
        } finally {
//            // 确保每个线程的InputStream在使用完毕后被关闭
//            closeInputStreamForThread();
        }
    }
    
    private InputStream getInputStreamForThread(String remoteFilename, ChannelSftp channelSftp) throws SftpException {
        // 检查ThreadLocal中是否有已存在的InputStream，如果没有则创建并存储
        InputStream inputStream = threadLocalInputStream.get();
        if (inputStream == null) {
            inputStream = channelSftp.get(remoteFilename);
            threadLocalInputStream.set(inputStream);
        }
        return inputStream;
    }

    private void closeInputStreamForThread() {
        // 获取并关闭当前线程的InputStream
        InputStream inputStream = threadLocalInputStream.get();
        if (inputStream != null) {
            try {
                inputStream.close();
            } catch (IOException e) {
                log.error(e.getMessage(), e);
            } finally {
                // 清除ThreadLocal中的引用，帮助垃圾回收
                threadLocalInputStream.remove();
            }
        }
    }
}
