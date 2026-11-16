/* 互动测验组件 - 所有 lessons 共享
   用法：容器加 data-quiz，正确选项加 data-correct，解释放 .explain
   行为：点击立即判定；答错时同时高亮正确答案；每题只能答一次 */
document.querySelectorAll('[data-quiz]').forEach(function (quiz) {
  var buttons = quiz.querySelectorAll('button');
  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (quiz.classList.contains('done')) return;
      var isRight = btn.hasAttribute('data-correct');
      if (isRight) { btn.classList.add('right'); quiz.classList.add('done'); }
      else {
        btn.classList.add('wrong');
        quiz.querySelector('[data-correct]').classList.add('right');
        quiz.classList.add('done');
      }
    });
  });
});
